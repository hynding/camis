import { describe, expect, it } from "vitest";
import { emitAuthController, emitUsernameMigration, USERNAME_MIGRATION_PATH } from "./auth";
import { emitStrapiErrorsMiddleware } from "./errors";

describe("strapi-api auth", () => {
  it("auth controller golden (with defaultRole)", async () => {
    await expect(emitAuthController("authenticated")).toMatchFileSnapshot(
      "./__golden__/strapi-api/AuthController.php",
    );
  });
  it("omits role assignment without a defaultRole", () => {
    expect(emitAuthController(undefined)).not.toContain("assignRole");
  });
  it("escapes a defaultRole containing a single quote and backslash", () => {
    expect(emitAuthController("it's-role")).toContain("assignRole('it\\'s-role')");
    expect(emitAuthController("back\\slash")).toContain("assignRole('back\\\\slash')");
  });
  it("resolves login by email first, falling back to username, deterministically", () => {
    const php = emitAuthController(undefined);
    expect(php).toContain("User::query()->where('email', $data['identifier'])->first()");
    expect(php).not.toContain("->orWhere('username'");
  });
  it("username migration golden sorts before the generated tables", async () => {
    expect(USERNAME_MIGRATION_PATH < "database/migrations/0001_01_02_000001_x.php").toBe(true);
    await expect(emitUsernameMigration()).toMatchFileSnapshot(
      "./__golden__/strapi-api/add_username_to_users_table.php",
    );
  });
  it("errors middleware golden", async () => {
    await expect(emitStrapiErrorsMiddleware()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiErrors.php",
    );
  });
});
