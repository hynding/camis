import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "../../generate";
import { runtimePhp } from "../../runtime-php";
import { authorRoleBundle } from "../__fixtures__/author-role";

// An endpoint's declared guards: a throttle, a body size limit, the media types it takes, and
// answers to browsers on any origin, each checked at its route before the handler runs.
const generate = (apiStyle: "laravel" | "strapi", bundle: IrBundle = authorRoleBundle) =>
  filamentAdapter.generate(bundle, { projectName: "press", apiStyle });
const strapi = generate("strapi");
const file = (path: string) => strapi.files.find((f) => f.path === path);
const unguarded: IrBundle = {
  ...authorRoleBundle,
  document: {
    ...authorRoleBundle.document,
    endpoints: (authorRoleBundle.document.endpoints ?? []).filter(
      (e) => !["MemoIngest", "MemoRestate", "MemoTally"].includes(e.name),
    ),
  },
};

const GUARD = "app/Http/Middleware/StrapiEndpointGuard.php";
const CORS = "app/Http/Middleware/StrapiEndpointCors.php";
const CONFIG = "config/camis-endpoints.php";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("filament endpoint guards", () => {
  it("guards the route and answers its preflight, among the open routes", () => {
    const routes = file("routes/api.php")!.content;
    const route =
      "Route::post('/memos/ingest', CamisEndpoints::class)->defaults('camis.endpoint', 'MemoIngest')->middleware([StrapiEndpointCors::class, StrapiEndpointGuard::class]);";
    const preflight =
      "Route::options('/memos/ingest', CamisEndpoints::class)->defaults('camis.endpoint', ['MemoIngest', 'MemoRestate'])->middleware(StrapiEndpointCors::class);";
    expect(routes).toContain(route);
    expect(routes).toContain(preflight);
    expect(routes).toContain(
      "Route::put('/memos/ingest', CamisEndpoints::class)->defaults('camis.endpoint', 'MemoRestate')->middleware(StrapiEndpointCors::class);",
    );
    // Laravel keeps only the last route of a method and path: one preflight answers every endpoint
    // on the path, by the method it asks for.
    expect(routes.split("Route::options('/memos/ingest'").length - 1).toBe(1);
    const open = routes.indexOf("Route::middleware(StrapiPublicRoute::class)->group(");
    expect(routes.indexOf(route)).toBeGreaterThan(open);
    expect(routes.indexOf(preflight)).toBeGreaterThan(open);
    expect(routes).toContain("use App\\Http\\Middleware\\StrapiEndpointCors;");
    expect(routes).toContain("use App\\Http\\Middleware\\StrapiEndpointGuard;");
  });

  // Laravel lets a path parameter replace a route default of the same name, and an IR path parameter
  // is letters, digits, _ and -, so the default naming the endpoint has a dot no parameter has.
  it("names the endpoint in a route default no path parameter can replace, and reads it there", () => {
    const routes = file("routes/api.php")!.content;
    expect(routes).toContain(
      "Route::get('/memos/{endpoint}/tally', CamisEndpoints::class)->defaults('camis.endpoint', 'MemoTally')->middleware(StrapiEndpointGuard::class);",
    );
    expect(routes).not.toContain("->defaults('endpoint'");
    for (const path of [GUARD, CORS, "app/Http/Controllers/Api/CamisEndpoints.php"]) {
      expect(file(path)!.content).toContain("'camis.endpoint'");
      expect(file(path)!.content).not.toMatch(/route\('endpoint'\)|defaults\['endpoint'\]/);
    }
  });

  it("leaves the routes of an endpoint with no guard as they were", () => {
    const routes = file("routes/api.php")!.content;
    expect(routes).toContain(
      "Route::post('/memos/{id}/pin', CamisEndpoints::class)->defaults('camis.endpoint', 'MemoPin');",
    );
    expect(routes).toContain(
      "Route::get('/memos/count', CamisEndpoints::class)->defaults('camis.endpoint', 'MemoCount');",
    );
    expect(routes).not.toContain("Route::options('/memos/count'");
  });

  it("states each guarded endpoint's guards in config, its throttle overridable by its own variable", async () => {
    await expect(file(CONFIG)!.content).toMatchFileSnapshot("./__golden__/camis-endpoints.php");
  });

  it("copies the runtime middlewares as they are", () => {
    expect(file(GUARD)!.content).toBe(runtimePhp(new URL(`./php/${GUARD}`, import.meta.url)));
    expect(file(CORS)!.content).toBe(runtimePhp(new URL(`./php/${CORS}`, import.meta.url)));
  });

  it("says in the contract what the route checked, and that a public endpoint's handler is the only authorization", async () => {
    await expect(file("app/Hooks/Contracts/MemoIngestEndpoint.php")!.content).toMatchFileSnapshot(
      "./__golden__/MemoIngestEndpoint.php",
    );
    expect(file("app/Hooks/Contracts/MemoCountEndpoint.php")!.content).toContain(
      "so this handler is the only\n     * authorization.",
    );
    expect(file("app/Hooks/Contracts/MemoPinEndpoint.php")!.content).not.toContain(
      "only authorization",
    );
  });

  it("lists each guarded endpoint's guards and its throttle's variable in DEPLOY.md", () => {
    const deploy = file("DEPLOY.md")!.content;
    expect(deploy).toContain("## Endpoint guards");
    expect(deploy).toContain(
      "| `MemoIngest` | `POST /api/memos/ingest` | 5 (`CAMIS_ENDPOINT_MEMO_INGEST_THROTTLE_PER_MINUTE`) | 64 | `application/json`, `text/plain` | `Content-Type`, `X-Memo-Key` |",
    );
    expect(deploy).toContain("StrapiEndpointCors::answers(...)");
    expect(
      generate("strapi", unguarded).files.find((f) => f.path === "DEPLOY.md")!.content,
    ).not.toContain("## Endpoint guards");
  });

  it("says in DEPLOY.md how the throttle reads the caller's address and counts it, and where the guards stand beside authentication", () => {
    const deploy = file("DEPLOY.md")!.content;
    // Read as prose, whatever the line breaks.
    const section = deploy.slice(deploy.indexOf("## Endpoint guards")).replace(/\s+/g, " ");
    for (const statement of [
      "an IPv6 caller by its /64",
      "an HMAC of the address under `APP_KEY`",
      "a whole number in ASCII digits, floored at 1; any other value keeps the declared rate",
      "`$middleware->trustProxies(at: [...])`",
      "every caller shares the proxy's address, and so one count",
      "On an endpoint that is not public, the route checks the caller's credentials first, before any guard, then the guards, then the roles the IR lists (403), then the handler.",
    ])
      expect(section).toContain(statement);
  });

  it("escapes a pipe and a backtick in a header name in DEPLOY.md's table", () => {
    const bundle: IrBundle = {
      ...unguarded,
      document: {
        ...unguarded.document,
        endpoints: [
          ...(unguarded.document.endpoints ?? []),
          {
            name: "MemoOdd",
            contentType: "Memo",
            method: "POST",
            path: "/memos/odd",
            public: true,
            crossOrigin: { headers: ["X|Key", "X`Key"] },
          },
        ],
      },
    };
    const deploy = generate("strapi", bundle).files.find((f) => f.path === "DEPLOY.md")!.content;
    expect(deploy).toContain(
      "| `MemoOdd` | `POST /api/memos/odd` |  |  |  | `X\\|Key`, `` X`Key `` |",
    );
  });

  it("emits neither the middlewares nor their config for a project whose endpoints have no guard", () => {
    const plain = generate("strapi", unguarded);
    for (const path of [GUARD, CORS, CONFIG])
      expect(plain.files.some((f) => f.path === path)).toBe(false);
    expect(plain.files.find((f) => f.path === "routes/api.php")!.content).not.toContain(
      "StrapiEndpoint",
    );
  });

  it("emits the guard alone for an endpoint that does not answer other origins", () => {
    const bundle: IrBundle = {
      ...unguarded,
      document: {
        ...unguarded.document,
        endpoints: [
          ...(unguarded.document.endpoints ?? []),
          {
            name: "MemoImport",
            contentType: "Memo",
            method: "PUT",
            path: "/memos/import",
            maxBodyBytes: 1024,
          },
        ],
      },
    };
    const result = generate("strapi", bundle);
    expect(result.files.some((f) => f.path === GUARD)).toBe(true);
    expect(result.files.some((f) => f.path === CORS)).toBe(false);
    const routes = result.files.find((f) => f.path === "routes/api.php")!.content;
    expect(routes).toContain(
      "Route::put('/memos/import', CamisEndpoints::class)->defaults('camis.endpoint', 'MemoImport')->middleware(StrapiEndpointGuard::class);",
    );
    expect(routes).not.toContain("StrapiEndpointCors");
  });

  it("laravel: reports a guarded endpoint as it reports every endpoint, with no route generated", () => {
    const result = generate("laravel");
    expect(result.gaps.gaps.find((g) => g.location.rule === "MemoIngest")).toEqual({
      feature: "endpoint",
      location: { contentType: "Memo", rule: "MemoIngest" },
      severity: "downgrade",
      message:
        'endpoint "MemoIngest" (POST /memos/ingest) is served only by apiStyle "strapi" on the laravel storage layout; its route and its guards (throttle, maxBodyBytes, accepts, crossOrigin) are not generated',
    });
    for (const path of [GUARD, CORS, CONFIG])
      expect(result.files.some((f) => f.path === path)).toBe(false);
  });
});

// The config evaluated by PHP with an env() that reads as Laravel's does.
describe.runIf(hasPhp())("config/camis-endpoints.php evaluated", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "camis-endpoints-"));
    writeFileSync(join(dir, "camis-endpoints.php"), file(CONFIG)!.content);
    writeFileSync(
      join(dir, "run.php"),
      `<?php
function env(string $key, mixed $default = null): mixed
{
    $value = getenv($key);
    return $value === false ? $default : $value;
}
echo json_encode(require __DIR__.'/camis-endpoints.php');
`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const evaluate = (env: Record<string, string>): unknown =>
    JSON.parse(
      execFileSync("php", [join(dir, "run.php")], {
        env: { PATH: process.env.PATH ?? "", ...env },
      }).toString(),
    );

  it("takes the IR's rate, or a deployment's own written in digits, and never less than one a minute", () => {
    const rate = (value?: string) =>
      (
        evaluate(
          value === undefined ? {} : { CAMIS_ENDPOINT_MEMO_INGEST_THROTTLE_PER_MINUTE: value },
        ) as Record<string, { throttle_per_minute: number }>
      ).MemoIngest!.throttle_per_minute;
    expect(rate()).toBe(5);
    expect(rate("120")).toBe(120);
    expect(rate("0")).toBe(1);
    // Anything but ASCII digits keeps the declared rate, as the Strapi target reads it.
    for (const other of ["", "1e3", "-3", "+7", " 7", "7 ", "abc", "12abc", "٣"])
      expect(rate(other)).toBe(5);
  });

  it("states the endpoint's method, size, media types and request headers", () => {
    expect(evaluate({})).toEqual({
      MemoIngest: {
        method: "POST",
        throttle_per_minute: 5,
        max_body_bytes: 64,
        accepts: ["application/json", "text/plain"],
        cross_origin_headers: ["Content-Type", "X-Memo-Key"],
      },
      MemoRestate: {
        method: "PUT",
        cross_origin_headers: ["Content-Type", "X-Memo-Version"],
      },
      MemoTally: { method: "GET", throttle_per_minute: 2 },
    });
  });
});
