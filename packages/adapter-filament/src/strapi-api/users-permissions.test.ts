import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../hooks/names";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import {
  emitStrapiActiveUser,
  emitStrapiSettings,
  emitStrapiUsers,
  emitUserController,
} from "./users-permissions";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const result = filamentAdapter.generate(strapiApiBundle, {
  projectName: "oyl",
  apiStyle: "strapi",
});
const content = (p: string): string => {
  const f = result.files.find((x) => x.path === p || x.path.endsWith(p));
  if (!f) throw new Error(`not generated: ${p}`);
  return f.content;
};

const generated = [
  "app/Support/StrapiUsers.php",
  "app/Support/StrapiSettings.php",
  "app/Http/Controllers/Api/UserController.php",
  "app/Http/Middleware/StrapiActiveUser.php",
  "app/Filament/Resources/Users/UserResource.php",
  "app/Filament/Resources/Users/Pages/CreateUser.php",
  "app/Filament/Resources/Users/Pages/EditUser.php",
  "app/Filament/Resources/Users/Pages/ListUsers.php",
  "app/Filament/Pages/UsersPermissionsSettings.php",
  "_add_users_permissions_to_users_table.php",
  "_create_strapi_settings_table.php",
];

describe("users-permissions runtime", () => {
  it.each(generated)("%s is generated", (path) => {
    expect(content(path).startsWith("<?php\n")).toBe(true);
  });
  it.each(generated.filter((path) => !path.startsWith("app/Filament/")))("%s is marked", (path) => {
    expect(content(path)).toContain(PHP_MARKER);
  });
  it("StrapiUsers golden", async () => {
    await expect(emitStrapiUsers()).toMatchFileSnapshot("./__golden__/strapi-api/StrapiUsers.php");
  });
  it("StrapiSettings golden", async () => {
    await expect(emitStrapiSettings()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiSettings.php",
    );
  });
  it("StrapiActiveUser golden", async () => {
    await expect(emitStrapiActiveUser()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiActiveUser.php",
    );
  });
  it("UserController golden", async () => {
    await expect(emitUserController(true)).toMatchFileSnapshot(
      "./__golden__/strapi-api/UserController.php",
    );
  });
  it("users carry Strapi's wire shape, timestamps included", () => {
    const php = emitStrapiUsers();
    for (const key of ["documentId", "provider", "confirmed", "blocked", "publishedAt"])
      expect(php).toContain(`'${key}' =>`);
  });
});

describe("users-permissions grants", () => {
  // The fixture grants only read: the writes must be refused, not merely left out of the admin.
  it("gates every user route on its own permission", () => {
    const php = content("app/Http/Controllers/Api/UserController.php");
    for (const permission of ["user.read", "user.create", "user.update", "user.delete"])
      expect(php).toContain(`'${permission}'`);
  });
  it("seeds the read grant on the builtin user", () => {
    expect(content("database/seeders/RolePermissionSeeder.php")).toContain("'user.read'");
  });
  it("an unsecured project answers the user routes without permission checks", () => {
    expect(emitUserController(false)).not.toContain("->can(");
  });
});

describe("users-permissions routes", () => {
  const routes = content("routes/api.php");
  it.each([
    "Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])",
    "Route::post('/auth/reset-password', [AuthController::class, 'resetPassword'])",
    "Route::get('/auth/email-confirmation', [AuthController::class, 'emailConfirmation'])",
    "Route::post('/auth/send-email-confirmation', [AuthController::class, 'sendEmailConfirmation'])",
    "Route::post('/auth/change-password', [AuthController::class, 'changePassword'])",
    "Route::get('/users/count', [UserController::class, 'count'])",
    "Route::delete('/users/{id}', [UserController::class, 'destroy'])",
  ])("routes %s", (route) => {
    expect(routes).toContain(route);
  });
  it("routes /users/count and /users/me before /users/{id}", () => {
    expect(routes.indexOf("'/users/count'")).toBeLessThan(routes.indexOf("'/users/{id}'"));
    expect(routes.indexOf("'/users/me'")).toBeLessThan(routes.indexOf("'/users/{id}'"));
  });
  it("checks a blocked or unconfirmed session on every authenticated route", () => {
    expect(routes).toMatch(/Route::middleware\(\['auth:sanctum', StrapiActiveUser::class\]\)/);
  });
  it("throttles the unauthenticated email endpoints with the credential ones", () => {
    expect(routes).toContain(
      "Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);",
    );
  });
});

describe("users-permissions config and errors", () => {
  it("keeps Strapi's advanced settings defaults in config", () => {
    const config = content("config/camis.php");
    for (const key of [
      "'allow_register'",
      "'email_confirmation'",
      "'unique_email'",
      "'email_reset_password'",
      "'email_confirmation_redirection'",
    ])
      expect(config).toContain(key);
  });
  // Strapi answers a request without credentials with the public role's verdict, and camis grants
  // the public role nothing, so it is a 403 there; a token that does not verify stays a 401.
  it("answers a request without a token with 403 Forbidden", () => {
    const php = content("app/Http/Middleware/StrapiErrors.php");
    expect(php).toContain("$request->bearerToken() === null");
    expect(php).toContain("$this->error(403, 'ForbiddenError', 'Forbidden')");
  });
});

describe.runIf(hasPhp())("users-permissions PHP", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "camis-users-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it.each([...generated, "app/Http/Controllers/Api/AuthController.php"])(
    "%s passes php -l",
    (path) => {
      const file = join(dir, path.replaceAll("/", "_"));
      writeFileSync(file, content(path));
      expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain("No syntax errors");
    },
  );
});
