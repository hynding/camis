import { describe, expect, it } from "vitest";
import { emitCorsConfig } from "./cors";

describe("emitCorsConfig — strapi::cors on Laravel's HandleCors", () => {
  // Browsers drop a credentialed response whose Allow-Origin is `*`; Strapi echoes the origin.
  it("allows credentials unless CAMIS_CORS_CREDENTIALS says otherwise", () => {
    expect(emitCorsConfig()).toContain(
      "'supports_credentials' => (bool) env('CAMIS_CORS_CREDENTIALS', true),",
    );
  });

  it("covers every path, as Strapi's global middleware does", () => {
    expect(emitCorsConfig()).toContain("'paths' => ['*'],");
  });

  it("reads the allowed origins from the environment, defaulting to any origin", () => {
    expect(emitCorsConfig()).toContain("'allowed_origins' => $list('CAMIS_CORS_ORIGIN', '*'),");
  });

  // camis import strapi writes these from config/middlewares' strapi::cors.
  it("reads strapi::cors's methods, headers, exposed headers and max age from the environment", () => {
    const config = emitCorsConfig();
    expect(config).toContain(
      "'allowed_methods' => $list('CAMIS_CORS_METHODS', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS'),",
    );
    expect(config).toContain(
      "'allowed_headers' => $list('CAMIS_CORS_HEADERS', 'Content-Type,Authorization,Origin,Accept'),",
    );
    expect(config).toContain("'exposed_headers' => $list('CAMIS_CORS_EXPOSE', ''),");
    expect(config).toContain("'max_age' => (int) env('CAMIS_CORS_MAX_AGE', 31536000),");
  });

  it("cors config golden (Strapi's methods, headers and max age)", async () => {
    await expect(emitCorsConfig()).toMatchFileSnapshot("../__golden__/strapi-api/config.cors.php");
  });
});
