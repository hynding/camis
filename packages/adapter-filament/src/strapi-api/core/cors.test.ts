import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitCorsConfig } from "./cors";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("emitCorsConfig — strapi::cors on Laravel's HandleCors", () => {
  it("covers every path, as Strapi's global middleware does", () => {
    expect(emitCorsConfig()).toContain("'paths' => ['*'],");
  });

  it("reads the allowed origins from the environment, defaulting to any origin", () => {
    expect(emitCorsConfig()).toContain("$origins = $list('CAMIS_CORS_ORIGIN', '*');");
  });

  // camis import strapi writes these from config/middlewares' strapi::cors.
  it("reads strapi::cors's methods, headers, exposed headers and max age from the environment", () => {
    const config = emitCorsConfig();
    expect(config).toContain(
      "'allowed_methods' => $list('CAMIS_CORS_METHODS', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS'),",
    );
    expect(config).toContain("'max_age' => (int) env('CAMIS_CORS_MAX_AGE', 31536000),");
  });

  it("cors config golden (Strapi's methods, headers and max age)", async () => {
    await expect(emitCorsConfig()).toMatchFileSnapshot("../__golden__/strapi-api/config.cors.php");
  });
});

// The config evaluated by PHP with an env() that reads as Laravel's does, for each env contract.
describe.runIf(hasPhp())("config/cors.php evaluated", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "camis-cors-"));
    writeFileSync(join(dir, "cors.php"), emitCorsConfig());
    writeFileSync(
      join(dir, "run.php"),
      `<?php
function env(string $key, mixed $default = null): mixed
{
    $value = getenv($key);
    if ($value === false) {
        return $default;
    }
    return match (strtolower($value)) {
        'true', '(true)' => true,
        'false', '(false)' => false,
        'null', '(null)' => null,
        default => $value,
    };
}
echo json_encode(require __DIR__.'/cors.php');
`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const evaluate = (env: Record<string, string>): Record<string, unknown> => {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("CAMIS_CORS_")),
    );
    return JSON.parse(
      execFileSync("php", [join(dir, "run.php")], { env: { ...clean, ...env }, encoding: "utf8" }),
    ) as Record<string, unknown>;
  };

  // With credentials, HandleCors echoes whichever origin `*` lets in: any site could then read
  // a response made with the visitor's refresh cookie. Any origin answers without credentials.
  it("answers any origin without credentials by default", () => {
    const config = evaluate({});
    expect(config.allowed_origins).toEqual(["*"]);
    expect(config.supports_credentials).toBe(false);
  });

  it("never allows credentials alongside `*`, even when asked to", () => {
    expect(
      evaluate({ CAMIS_CORS_ORIGIN: "https://app.example.test,*", CAMIS_CORS_CREDENTIALS: "true" })
        .supports_credentials,
    ).toBe(false);
  });

  it("allows credentials for the origins listed, unless CAMIS_CORS_CREDENTIALS is false", () => {
    const listed = evaluate({ CAMIS_CORS_ORIGIN: "https://app.example.test, https://b.test" });
    expect(listed.allowed_origins).toEqual(["https://app.example.test", "https://b.test"]);
    expect(listed.supports_credentials).toBe(true);
    expect(
      evaluate({ CAMIS_CORS_ORIGIN: "https://app.example.test", CAMIS_CORS_CREDENTIALS: "false" })
        .supports_credentials,
    ).toBe(false);
  });

  // X-Requested-With and x-strapi-refresh-cookie are how a client shows the refresh cookie is
  // sent by its own page; Retry-After tells it when a throttled request may be tried again.
  it("allows the headers a cookie client sends and exposes Retry-After by default", () => {
    const config = evaluate({});
    expect(config.allowed_headers).toEqual([
      "Content-Type",
      "Authorization",
      "Origin",
      "Accept",
      "X-Requested-With",
      "x-strapi-refresh-cookie",
    ]);
    expect(config.exposed_headers).toEqual(["Retry-After"]);
  });

  it("keeps the lists an imported strapi::cors sets", () => {
    const config = evaluate({ CAMIS_CORS_HEADERS: "*", CAMIS_CORS_EXPOSE: "X-Total" });
    expect(config.allowed_headers).toEqual(["*"]);
    expect(config.exposed_headers).toEqual(["X-Total"]);
  });
});
