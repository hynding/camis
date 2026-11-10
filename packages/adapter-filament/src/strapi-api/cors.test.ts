import { describe, expect, it } from "vitest";
import { emitCorsConfig } from "./cors";

describe("emitCorsConfig — strapi::cors defaults on Laravel's HandleCors", () => {
  // Browsers drop a credentialed response whose Allow-Origin is `*`; Strapi echoes the origin.
  it("allows credentials, so a wildcard origin is echoed back instead of sent as *", () => {
    expect(emitCorsConfig()).toContain("'supports_credentials' => true,");
  });

  it("covers every path, as Strapi's global middleware does", () => {
    expect(emitCorsConfig()).toContain("'paths' => ['*'],");
  });

  it("reads the allowed origins from the environment, defaulting to any origin", () => {
    expect(emitCorsConfig()).toContain(
      "'allowed_origins' => array_map('trim', explode(',', (string) env('CAMIS_CORS_ORIGIN', '*'))),",
    );
  });

  it("cors config golden (Strapi's methods, headers and max age)", async () => {
    await expect(emitCorsConfig()).toMatchFileSnapshot("./__golden__/strapi-api/config.cors.php");
  });
});
