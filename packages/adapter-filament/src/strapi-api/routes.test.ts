import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emitApiConfig } from "./routes";

const goldenLaravel = fileURLToPath(
  new URL("./__golden__/strapi-api/config.camis.php", import.meta.url),
);

describe("emitApiConfig", () => {
  it("defaults to the laravel layout, byte-identical to the existing golden", () => {
    const php = emitApiConfig();
    expect(php).toBe(readFileSync(goldenLaravel, "utf8"));
    expect(php).toBe(emitApiConfig("laravel"));
  });

  it("strapi layout golden", async () => {
    await expect(emitApiConfig("strapi")).toMatchFileSnapshot(
      "../__golden__/storage/config.camis.php",
    );
  });

  it("strapi layout adds jwt_secret and email_confirmation, each with a short comment", () => {
    const php = emitApiConfig("strapi");
    expect(php).toContain("'jwt_secret' => (string) env('JWT_SECRET', ''),");
    expect(php).toContain("'email_confirmation' => (bool) env('CAMIS_EMAIL_CONFIRMATION', false),");
  });

  it("laravel layout does not mention jwt_secret or email_confirmation", () => {
    const php = emitApiConfig();
    expect(php).not.toContain("jwt_secret");
    expect(php).not.toContain("email_confirmation");
  });

  it("strapi layout still carries the auth_throttle_per_minute key", () => {
    const php = emitApiConfig("strapi");
    expect(php).toContain(
      "'auth_throttle_per_minute' => max(1, (int) env('CAMIS_AUTH_THROTTLE_PER_MINUTE', 10)),",
    );
  });
});
