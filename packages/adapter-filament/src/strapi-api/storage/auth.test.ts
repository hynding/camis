import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../../hooks/names";
import { emitStorageAuthController } from "./auth";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("emitStorageAuthController", () => {
  it("golden", async () => {
    await expect(emitStorageAuthController("authenticated")).toMatchFileSnapshot(
      "../../__golden__/storage/AuthController.php",
    );
  });

  it("opens with the marker, strict types and its namespace", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
    expect(php).toContain("namespace App\\Http\\Controllers\\Api;");
    expect(php).toContain("class AuthController extends Controller");
    expect(php.endsWith("\n")).toBe(true);
  });

  it("is idempotent", () => {
    expect(emitStorageAuthController("authenticated")).toBe(
      emitStorageAuthController("authenticated"),
    );
  });

  it("falls back to Strapi's own default role literal 'authenticated' when defaultRole is undefined", () => {
    const withDefault = emitStorageAuthController("authenticated");
    const withUndefined = emitStorageAuthController(undefined);
    expect(withUndefined).toBe(withDefault);
    expect(withUndefined).toContain("'type', 'authenticated')");
  });

  it("mints a Strapi-shaped HS256 JWT rather than a Sanctum token", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php).toContain("JWT::encode(");
    expect(php).toContain("'HS256'");
    expect(php).not.toContain("createToken");
  });

  it("links the role through up_users_role_lnk with the user_ord column", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php).toContain("'user_ord'");
    expect(php).toContain("StrapiRows::link($user, 'up_users_role_lnk', 'user_id', 'role_id'");
  });

  it("validates registration fields without a unique: rule (Strapi has no unique index)", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php).not.toContain("unique:");
    expect(php).toContain("'username' => ['required', 'string', 'min:3']");
    expect(php).toContain("'email' => ['required', 'email']");
    expect(php).toContain("'password' => ['required', 'string', 'min:6']");
  });

  // Strapi hashes with bcryptjs, which writes the `$2a$` prefix; PHP's password_get_info reports
  // that as "unknown", so Laravel's BcryptHasher refuses it outright ("This password does not use
  // the Bcrypt algorithm") and every Strapi-registered user gets a 500 at login. password_verify
  // accepts every bcrypt minor, exactly as bcryptjs does, and password_hash(PASSWORD_BCRYPT)
  // guarantees the column stays readable by Strapi whatever HASH_DRIVER the app is configured with.
  it("verifies and writes bcrypt directly rather than through the configured hash driver", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php).toContain("password_verify($data['password'], (string) $user->password)");
    expect(php).toContain("password_hash($data['password'], PASSWORD_BCRYPT, [");
    expect(php).toContain("config('hashing.bcrypt.rounds', 10)");
    expect(php).not.toContain("Hash::check(");
    expect(php).not.toContain("Hash::make(");
    expect(php).not.toContain("use Illuminate\\Support\\Facades\\Hash;");
  });

  it("rejects a duplicate email or username with Strapi's own message", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php).toContain("Email or Username are already taken");
  });

  it("uses Strapi's own login-failure messages, in Strapi's own order", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php).toContain("Your account email is not confirmed");
    expect(php).toContain("Your account has been blocked by an administrator");
  });

  it("reads camis.email_confirmation for both registration and login", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php).toContain("config('camis.email_confirmation')");
  });

  // Without a transaction, a missing (or renamed) up_roles row commits the user row and then
  // fails on the link: the account can log in, every policy denies it because it has no role, and
  // the identifier is burned for good — the uniqueness check would reject a retry.
  it("registers the user and its role link in one transaction, looking the role up first", () => {
    const php = emitStorageAuthController("authenticated");
    const body = php.slice(
      php.indexOf("public function register"),
      php.indexOf("public function login"),
    );
    expect(body).toContain("DB::transaction(function () use ($user): void {");
    // Role lookup, then insert, then link — in that order, all inside the closure.
    const lookup = body.indexOf("UpRole::query()");
    const create = body.indexOf("StrapiRows::create($user);");
    const link = body.indexOf("StrapiRows::link(");
    const open = body.indexOf("DB::transaction(");
    const close = body.indexOf("});", link);
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(create);
    expect(create).toBeLessThan(link);
    expect(close).toBeGreaterThan(link);
  });

  it("imports the DB facade", () => {
    expect(emitStorageAuthController("authenticated")).toContain(
      "use Illuminate\\Support\\Facades\\DB;",
    );
  });

  // firstOrFail() throws ModelNotFoundException, which Laravel rewrites to a 404 — indistinguishable
  // from "no such route" and wrong besides: an absent up_roles row is a deployment/config error on
  // the operator's side, which StrapiErrors renders as a 500.
  it("names the missing up_roles row explicitly instead of firstOrFail's 404", () => {
    const php = emitStorageAuthController("authenticated");
    expect(php).not.toContain("firstOrFail()");
    expect(php).toContain("$role = UpRole::query()->where('type', 'authenticated')->first();");
    expect(php).toContain("if ($role === null) {");
    expect(php).toContain(
      "'up_roles has no row with type \\'authenticated\\'; boot Strapi against this database first'",
    );
    expect(php).toContain("throw new \\RuntimeException(");
  });

  it("escapes a single quote in defaultRole so it cannot break out of the PHP string literal", () => {
    const php = emitStorageAuthController("o'brien");
    expect(php).toContain("'type', 'o\\'brien')");
    // The escaped quote must not terminate the literal early — a real php -l lint of this
    // exact output runs below ("lints clean with an injected defaultRole").
    expect(php).not.toContain("'type', 'o'brien')");
  });
});

describe("emitStorageAuthController — php -l", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "storage-auth-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasPhp())("lints clean", () => {
    const file = join(dir, "AuthController.php");
    writeFileSync(file, emitStorageAuthController("authenticated"));
    const out = execFileSync("php", ["-l", file], { encoding: "utf8" });
    expect(out).toContain("No syntax errors detected");
  });

  it.skipIf(!hasPhp())("lints clean with an injected defaultRole", () => {
    const file = join(dir, "AuthControllerInjected.php");
    writeFileSync(file, emitStorageAuthController("o'brien"));
    const out = execFileSync("php", ["-l", file], { encoding: "utf8" });
    expect(out).toContain("No syntax errors detected");
  });
});
