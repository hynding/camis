import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TS_MARKER } from "@camis/adapter-kernel";
import type { Endpoint, IrDocument } from "@camis/ir-schema";
import { strapiAdapter } from "../generate";
import { importEndpoints } from "../import/endpoints";
import { importDocument } from "../import/import-document";
import { customCodeDoc } from "../__fixtures__/custom-code";

// An endpoint's declared guards, checked by a generated global middleware after strapi::cors (so a
// refusal carries the app's CORS headers) and ahead of strapi::body (so a refused body is never
// parsed); an endpoint answering browsers on any origin is answered by another, ahead of
// strapi::cors, so the app's CORS never answers for it.
const ingest: Endpoint = {
  name: "ArticleIngest",
  contentType: "Article",
  method: "POST",
  path: "/articles/:id/ingest",
  public: true,
  throttle: { perMinute: 3 },
  maxBodyBytes: 64,
  accepts: ["application/json", "Text/Plain"],
  crossOrigin: { headers: ["Content-Type", "X-Write-Key"] },
};
const guardedDoc = (...endpoints: Endpoint[]): IrDocument => ({
  ...customCodeDoc,
  endpoints: [...(customCodeDoc.endpoints ?? []), ...endpoints],
});
const generate = (doc: IrDocument) =>
  strapiAdapter.generate({ document: doc, roles: [] }, { projectName: "blog" });
// A second guarded endpoint, which takes turns of a bucket of its own.
const ping: Endpoint = {
  name: "ArticlePing",
  contentType: "Article",
  method: "GET",
  path: "/articles/ping",
  public: true,
  throttle: { perMinute: 1 },
};
// A PUT on the ingest path answering browsers with other request headers, and no guard checked.
const restate: Endpoint = {
  name: "ArticleRestate",
  contentType: "Article",
  method: "PUT",
  path: "/articles/:id/ingest",
  public: true,
  crossOrigin: { headers: ["Content-Type", "X-Version"] },
};
const guarded = generate(guardedDoc(ingest, ping, restate));
const file = (result: ReturnType<typeof generate>, path: string) =>
  result.files.find((f) => f.path === path);
const execFileAsync = promisify(execFile);
const MIDDLEWARE = "src/middlewares/camis_endpoint_guards.ts";
const CORS_MIDDLEWARE = "src/middlewares/camis_endpoint_cors.ts";

describe("strapi endpoint guards: the generated project", () => {
  it("answers other origins ahead of strapi::cors, and checks the guards after it and ahead of strapi::body", async () => {
    const config = file(guarded, "config/middlewares.ts")!.content;
    await expect(config).toMatchFileSnapshot("./__golden__/middlewares.guarded.ts.txt");
    const at = (name: string) => config.indexOf(`'${name}'`);
    expect(at("global::camis_endpoint_cors")).toBeGreaterThan(at("strapi::errors"));
    expect(at("global::camis_endpoint_cors")).toBeLessThan(at("strapi::cors"));
    expect(at("global::camis_endpoint_guards")).toBeGreaterThan(at("strapi::cors"));
    expect(at("global::camis_endpoint_guards")).toBeLessThan(at("strapi::body"));
  });

  it("generates the middlewares, marked as generated", async () => {
    const middleware = file(guarded, MIDDLEWARE)!;
    expect(middleware.mode).toBeUndefined();
    expect(middleware.content.startsWith(TS_MARKER)).toBe(true);
    await expect(middleware.content).toMatchFileSnapshot(
      "./__golden__/camis_endpoint_guards.ts.txt",
    );
    const cors = file(guarded, CORS_MIDDLEWARE)!;
    expect(cors.content.startsWith(TS_MARKER)).toBe(true);
    await expect(cors.content).toMatchFileSnapshot("./__golden__/camis_endpoint_cors.ts.txt");
  });

  it("generates only the middleware an endpoint's guards need", () => {
    const checksOnly = generate(guardedDoc(ping));
    expect(file(checksOnly, MIDDLEWARE)).toBeDefined();
    expect(file(checksOnly, CORS_MIDDLEWARE)).toBeUndefined();
    expect(file(checksOnly, "config/middlewares.ts")!.content).not.toContain("camis_endpoint_cors");
    const corsOnly = generate(guardedDoc(restate));
    expect(file(corsOnly, MIDDLEWARE)).toBeUndefined();
    expect(file(corsOnly, CORS_MIDDLEWARE)).toBeDefined();
    expect(file(corsOnly, "config/middlewares.ts")!.content).not.toContain("camis_endpoint_guards");
  });

  it("leaves a project whose endpoints have no guard as it was", () => {
    const plain = generate(customCodeDoc);
    expect(file(plain, MIDDLEWARE)).toBeUndefined();
    expect(file(plain, CORS_MIDDLEWARE)).toBeUndefined();
    expect(file(plain, "config/middlewares.ts")!.content).not.toContain("camis_endpoint");
    expect(plain.gaps.gaps).toEqual([]);
  });

  it("writes DEPLOY.md for an operator: each guarded endpoint, its variables, and what the throttle can and cannot do", () => {
    const deploy = file(guarded, "DEPLOY.md")!.content;
    expect(deploy.startsWith("<!-- @camis:generated — do not edit -->")).toBe(true);
    expect(deploy).toContain(
      "| `ArticleIngest` | `POST /api/articles/:id/ingest` | 3 (`CAMIS_ENDPOINT_ARTICLE_INGEST_THROTTLE_PER_MINUTE`) | 64 | `application/json`, `text/plain` | `Content-Type`, `X-Write-Key` |",
    );
    const prose = deploy.replace(/\s+/g, " ");
    for (const statement of [
      "`CAMIS_ENDPOINT_MAX_TRACKED_CALLERS`",
      "100000 by default",
      "every caller not tracked shares one count for the endpoint, limited to the endpoint's rate a window",
      "a caller's count stops taking room once it has expired",
      "an attacker who keeps the cap's worth of distinct callers active every minute (an IPv6 caller counted by its /64) holds it full",
      "every caller not already tracked then shares the endpoint's rate in total",
      "a limit at the reverse proxy or the network",
      "about 205 bytes a caller",
      "about 20 MB of memory per throttled endpoint",
      "a caller already tracked keeps its own count until it expires",
      "about 1 MiB more of its body is read and discarded",
      "can lose the refusal of a body more than about 1 MiB over the limit, as behind nginx",
      "dropped when the client ends it or at most 2 seconds after the answer",
      "request sent after the refused one on the same connection is not processed",
      "while the middlewares listed ahead of the camis ones keep requests in order",
      "up to twice its rate across the turn of a window",
      "an IPv6 caller by its /64",
      "NAT64, Teredo",
      "changing `APP_KEYS` starts every count afresh",
      "`server.proxy`",
      "`X-Forwarded-For`",
      "each Strapi process counts apart",
      "before Strapi authenticates the caller and asks its role",
    ])
      expect(prose).toContain(statement);
    expect(file(generate(customCodeDoc), "DEPLOY.md")).toBeUndefined();
    expect(
      importDocument(guarded.files).gaps.gaps.filter((g) => g.location.file === "DEPLOY.md"),
    ).toEqual([]);
  });

  it("says in a public endpoint's seeded controller that its handler is the only authorization", () => {
    const controller = file(guarded, "src/api/article/controllers/article-ingest.ts")!.content;
    expect(controller).toContain(
      "// auth: false: no caller is authenticated and no role is asked, so this handler is the only\n// authorization.",
    );
    expect(file(guarded, "src/api/article/controllers/article-like.ts")!.content).not.toContain(
      "only authorization",
    );
  });

  it("is read back as the endpoint without its guards, which an import does not carry, and passes over the generated middleware", () => {
    const routes = guarded.files
      .filter((f) => f.path.endsWith("/routes/01-endpoints.ts"))
      .map((f) => ({ path: f.path, content: f.content.replace(TS_MARKER, "") }));
    const route = {
      name: ingest.name,
      contentType: ingest.contentType,
      method: ingest.method,
      path: ingest.path,
      public: true,
    };
    expect(importEndpoints(routes, guardedDoc(ingest, ping, restate)).endpoints).toEqual([
      ...(customCodeDoc.endpoints ?? []),
      route,
      {
        name: ping.name,
        contentType: ping.contentType,
        method: "GET",
        path: ping.path,
        public: true,
      },
      {
        name: restate.name,
        contentType: restate.contentType,
        method: "PUT",
        path: restate.path,
        public: true,
      },
    ]);
    const imported = importDocument(guarded.files);
    expect(imported.document.ok).toBe(true);
    expect(imported.gaps.gaps.filter((g) => g.location.file?.includes("middlewares"))).toEqual([]);
  });

  it("reports a body limit above what strapi::body parses for an accepted media type, located at the endpoint", () => {
    const large = { ...ingest, maxBodyBytes: 100_000 };
    expect(generate(guardedDoc(large)).gaps.gaps).toEqual([
      {
        feature: "endpointBodyLimit",
        location: { contentType: "Article", rule: "ArticleIngest" },
        severity: "downgrade",
        message:
          'endpoint "ArticleIngest" allows a body of 100000 bytes, but strapi::body refuses a text/plain body over 57344 bytes (its textLimit, 56kb) with 413 first, as camis generates config/middlewares with strapi::body\'s defaults',
      },
    ]);
    const json = { ...ingest, accepts: ["application/json"], maxBodyBytes: 2_000_000 };
    expect(generate(guardedDoc(json)).gaps.gaps.map((g) => g.message)).toEqual([
      'endpoint "ArticleIngest" allows a body of 2000000 bytes, but strapi::body refuses an application/json body over 1048576 bytes (its jsonLimit, 1mb) with 413 first, as camis generates config/middlewares with strapi::body\'s defaults',
    ]);
    const any = { ...ingest, accepts: undefined, maxBodyBytes: 60_000 };
    expect(generate(guardedDoc(any)).gaps.gaps.map((g) => g.message)).toEqual([
      'endpoint "ArticleIngest" allows a body of 60000 bytes, but strapi::body refuses an application/x-www-form-urlencoded body over 57344 bytes (its formLimit, 56kb) and a text/* body over 57344 bytes (its textLimit, 56kb) with 413 first, as camis generates config/middlewares with strapi::body\'s defaults',
    ]);
    expect(generate(guardedDoc({ ...ingest, maxBodyBytes: 57_344 })).gaps.gaps).toEqual([]);
  });
});

/** The connection under a request, as a refusal's lingering close uses it. */
class FakeSocket extends EventEmitter {
  bytesRead = 0;
  writable = true;
  ended = false;
  destroyed = false;
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** A Koa context as the middlewares read and write it. */
interface FakeContext {
  method: string;
  path: string;
  req: Readable & {
    headers: Record<string, string>;
    socket: FakeSocket;
    method: string;
    url: string;
  };
  request: { ip: string; req?: unknown };
  res: EventEmitter;
  status: number;
  body: unknown;
  /** Koa's: false once a middleware has told Koa not to answer. */
  respond?: boolean;
  response: Record<string, string>;
  get(name: string): string;
  set(name: string, value: string): void;
  remove(name: string): void;
}

type Middleware = (ctx: FakeContext, next: () => Promise<void>) => Promise<void>;
type Factory = (config: unknown, deps: { strapi: unknown }) => Middleware;

// Strapi's config as a new project has it: every key at its default, and the app's keys set.
const APP_KEYS = ["first-key", "second-key"];
const strapi = {
  config: {
    get: (key: string, fallback: unknown) => (key === "server.app.keys" ? APP_KEYS : fallback),
  },
};

const context = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body: Buffer | Buffer[] | undefined = undefined,
  ip = "203.0.113.7",
): FakeContext => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const socket = new FakeSocket();
  const req = Object.assign(Readable.from(body === undefined ? [] : [body].flat()), {
    headers: lower,
    socket,
    method,
    url: path,
  });
  const response: Record<string, string> = {};
  return {
    method,
    path,
    req,
    request: { ip, req },
    res: new EventEmitter(),
    status: 404,
    body: undefined,
    response,
    get: (name) => lower[name.toLowerCase()] ?? "",
    set: (name, value) => {
      response[name.toLowerCase()] = value;
    },
    remove: (name) => {
      delete response[name.toLowerCase()];
    },
  };
};

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
};

// strapi::cors as the app's CORS answers a listed origin: it allows that origin with credentials
// before the rest runs, and answers a preflight itself.
const appCors: Middleware = async (ctx, next) => {
  if (ctx.get("Origin") !== "") {
    ctx.set("Access-Control-Allow-Origin", ctx.get("Origin"));
    ctx.set("Access-Control-Allow-Credentials", "true");
  }
  if (ctx.method === "OPTIONS" && ctx.get("Access-Control-Request-Method") !== "") {
    ctx.status = 204;
    return;
  }
  await next();
};

describe("strapi endpoint guards: the generated middlewares at work", () => {
  let dir = "";
  let guardsFactory: Factory;
  let corsFactory: Factory;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "camis-endpoint-guards-"));
    const load = async (path: string, name: string): Promise<Factory> => {
      const target = join(dir, name);
      writeFileSync(target, file(guarded, path)!.content);
      return ((await import(pathToFileURL(target).href)) as { default: Factory }).default;
    };
    guardsFactory = await load(MIDDLEWARE, "camis_endpoint_guards.ts");
    corsFactory = await load(CORS_MIDDLEWARE, "camis_endpoint_cors.ts");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());

  /** The middlewares as config/middlewares runs them, around strapi::cors; fresh counters. */
  const stack = (config: unknown = {}): Middleware => {
    const cors = corsFactory({}, { strapi });
    const guards = guardsFactory(config, { strapi });
    return (ctx, next) => cors(ctx, () => appCors(ctx, () => guards(ctx, next)));
  };

  /** Runs one request through the middlewares; next() stands for the route's handler. */
  const run = async (
    ctx: FakeContext,
    middleware: Middleware = stack(),
  ): Promise<{ ctx: FakeContext; reached: boolean; seen: string | undefined }> => {
    let reached = false;
    let seen: string | undefined;
    await middleware(ctx, async () => {
      reached = true;
      seen = await readAll(ctx.req);
      ctx.status = 200;
      ctx.body = { data: seen };
    });
    return { ctx, reached, seen };
  };
  const post = (body: string, headers: Record<string, string> = {}, ip?: string) =>
    context(
      "POST",
      "/api/articles/7/ingest",
      {
        Origin: "https://site.example",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        ...headers,
      },
      Buffer.from(body),
      ip,
    );
  const openToAnyOrigin = (ctx: FakeContext): void => {
    expect(ctx.response["access-control-allow-origin"]).toBe("*");
    expect(ctx.response["access-control-allow-credentials"]).toBeUndefined();
    expect(ctx.response["access-control-expose-headers"]).toBe("Retry-After");
  };
  const refusedBody = (ctx: FakeContext, status: number, name: string): void => {
    expect(ctx.status).toBe(status);
    expect(ctx.body).toEqual({
      data: null,
      error: { status, name, message: expect.any(String) as string, details: {} },
    });
  };
  const refused = (ctx: FakeContext, status: number, name: string): void => {
    refusedBody(ctx, status, name);
    openToAnyOrigin(ctx);
  };

  it("answers the preflight for the endpoint's method with exactly its request headers", async () => {
    const { ctx, reached } = await run(
      context("OPTIONS", "/api/articles/7/ingest", {
        Origin: "https://site.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-write-key",
      }),
    );
    expect(reached).toBe(false);
    expect(ctx.status).toBe(204);
    expect(ctx.response).toEqual({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "Content-Type, X-Write-Key",
      "access-control-expose-headers": "Retry-After",
      "access-control-max-age": "7200",
      vary: "Access-Control-Request-Method, Access-Control-Request-Headers",
    });
  });

  it("answers each endpoint on a path by the method its preflight asks for", async () => {
    const { ctx } = await run(
      context("OPTIONS", "/api/articles/7/ingest", {
        Origin: "https://site.example",
        "Access-Control-Request-Method": "PUT",
      }),
    );
    expect(ctx.response["access-control-allow-methods"]).toBe("PUT");
    expect(ctx.response["access-control-allow-headers"]).toBe("Content-Type, X-Version");
    expect(ctx.response["access-control-allow-credentials"]).toBeUndefined();
  });

  it("leaves another method's preflight, and every other path, to the app's CORS", async () => {
    const other = await run(
      context("OPTIONS", "/api/articles/7/ingest", {
        Origin: "https://site.example",
        "Access-Control-Request-Method": "DELETE",
      }),
    );
    expect(other.ctx.response["access-control-allow-credentials"]).toBe("true");
    const elsewhere = await run(
      context("GET", "/api/articles", { Origin: "https://site.example" }),
    );
    expect(elsewhere.reached).toBe(true);
    expect(elsewhere.ctx.response["access-control-allow-credentials"]).toBe("true");
  });

  it("matches the path as Strapi's router does: any case, a trailing slash, a param as one segment", async () => {
    const middleware = stack();
    for (const path of ["/API/Articles/7/Ingest", "/api/articles/7/ingest/"]) {
      const ctx = post("{}");
      ctx.path = path;
      expect((await run(ctx, middleware)).ctx.response["access-control-allow-origin"]).toBe("*");
    }
    const deeper = post("{}");
    deeper.path = "/api/articles/7/8/ingest";
    expect((await run(deeper, middleware)).ctx.response["access-control-allow-credentials"]).toBe(
      "true",
    );
  });

  it("passes a JSON and a text body on, its CORS headers replacing the app's", async () => {
    const middleware = stack();
    const json = await run(post('{"a":1}'), middleware);
    expect(json.seen).toBe('{"a":1}');
    openToAnyOrigin(json.ctx);
    const text = await run(
      post("hello", { "Content-Type": "text/plain;charset=UTF-8" }),
      middleware,
    );
    expect(text.seen).toBe("hello");
    openToAnyOrigin(text.ctx);
  });

  it("keeps its CORS headers on an error the rest of Strapi throws", async () => {
    const ctx = post("{}");
    await expect(
      stack()(ctx, () => {
        ctx.set("Access-Control-Allow-Credentials", "true");
        return Promise.reject(new Error("handler failed"));
      }),
    ).rejects.toThrow("handler failed");
    openToAnyOrigin(ctx);
  });

  it("refuses a caller over the throttle with 429 and Retry-After, counting refused requests, per address", async () => {
    const middleware = stack();
    expect(
      (await run(post("<a/>", { "Content-Type": "application/xml" }), middleware)).ctx.status,
    ).toBe(415);
    expect((await run(post("{}"), middleware)).reached).toBe(true);
    expect((await run(post("{}"), middleware)).reached).toBe(true);
    const over = await run(post("{}"), middleware);
    expect(over.reached).toBe(false);
    refused(over.ctx, 429, "RateLimitError");
    expect(Number(over.ctx.response["retry-after"])).toBeGreaterThan(0);
    expect((await run(post("{}", {}, "198.51.100.1"), middleware)).reached).toBe(true);
  });

  it("carries the app's CORS headers on a refusal of an endpoint that does not answer other origins itself", async () => {
    const middleware = stack();
    const ping = () => context("GET", "/api/articles/ping", { Origin: "https://site.example" });
    expect((await run(ping(), middleware)).reached).toBe(true);
    const over = await run(ping(), middleware);
    expect(over.reached).toBe(false);
    refusedBody(over.ctx, 429, "RateLimitError");
    expect(over.ctx.response["access-control-allow-origin"]).toBe("https://site.example");
    expect(over.ctx.response["access-control-allow-credentials"]).toBe("true");
    expect(Number(over.ctx.response["retry-after"])).toBeGreaterThan(0);
  });

  it("counts each endpoint in a bucket of its own, a GET's HEAD in the GET's", async () => {
    const middleware = stack();
    for (let i = 0; i < 3; i += 1) expect((await run(post("{}"), middleware)).reached).toBe(true);
    const pinged = await run(context("GET", "/api/articles/ping"), middleware);
    expect(pinged.reached).toBe(true);
    const head = await run(context("HEAD", "/api/articles/ping"), middleware);
    expect(head.reached).toBe(false);
    expect(head.ctx.status).toBe(429);
  });

  it("counts an IPv6 caller by its /64, and an IPv4 address mapped into IPv6 as that address", async () => {
    const middleware = stack();
    for (const ip of ["2001:db8:0:1::1", "2001:db8:0:1:ffff::2", "2001:DB8:0:1:0:0:0:3"])
      expect((await run(post("{}", {}, ip), middleware)).reached).toBe(true);
    expect((await run(post("{}", {}, "2001:db8:0:1::4"), middleware)).ctx.status).toBe(429);
    expect((await run(post("{}", {}, "2001:db8:0:2::1"), middleware)).reached).toBe(true);
    for (const ip of ["198.51.100.9", "::ffff:198.51.100.9", "::ffff:c633:6409"])
      expect((await run(post("{}", {}, ip), middleware)).reached).toBe(true);
    expect((await run(post("{}", {}, "198.51.100.9"), middleware)).ctx.status).toBe(429);
  });

  it("keys the counter with an HMAC of the address under the app's keys, never the address or its plain hash", async () => {
    const source = file(guarded, MIDDLEWARE)!.content;
    expect(source).toContain('createHmac("sha256"');
    expect(source).not.toContain("createHash(");
    expect(source).toContain('"server.app.keys"');
  });

  it("takes a deployment's own rate from the endpoint's variable only when it is digits, never less than one", async () => {
    const variable = "CAMIS_ENDPOINT_ARTICLE_INGEST_THROTTLE_PER_MINUTE";
    const allowed = async (): Promise<number> => {
      const middleware = stack();
      let n = 0;
      while ((await run(post("{}"), middleware)).reached) n += 1;
      return n;
    };
    try {
      process.env[variable] = "1";
      expect(await allowed()).toBe(1);
      process.env[variable] = "0";
      expect(await allowed()).toBe(1);
      // Anything but ASCII digits keeps the declared rate, as the Filament target reads it.
      for (const other of ["", "1e3", "-3", "+2", " 2", "abc", "2abc", "٢"]) {
        process.env[variable] = other;
        expect(await allowed()).toBe(3);
      }
    } finally {
      delete process.env[variable];
    }
  });

  /** The clocks the middleware may read: a monotonic one, and the wall clock, set apart. */
  const clocks = () => {
    const at = { monotonic: 5_000, wall: 1_700_000_000_000 };
    vi.spyOn(performance, "now").mockImplementation(() => at.monotonic);
    vi.spyOn(Date, "now").mockImplementation(() => at.wall);
    return at;
  };
  const ping = (ip: string) => context("GET", "/api/articles/ping", {}, undefined, ip);

  it("counts windows by a monotonic clock, so a step of the wall clock changes nothing", async () => {
    const at = clocks();
    const middleware = stack();
    expect((await run(ping("192.0.2.1"), middleware)).reached).toBe(true);
    expect((await run(ping("192.0.2.1"), middleware)).ctx.status).toBe(429);
    // The wall clock jumps two minutes ahead: the count stands.
    at.wall += 120_000;
    at.monotonic += 1_000;
    expect((await run(ping("192.0.2.1"), middleware)).ctx.status).toBe(429);
    // A minute passes while the wall clock steps an hour back: the count is over.
    at.wall -= 3_600_000;
    at.monotonic += 61_000;
    expect((await run(ping("192.0.2.1"), middleware)).reached).toBe(true);
  });

  const MAX_TRACKED = "CAMIS_ENDPOINT_MAX_TRACKED_CALLERS";
  const withMaxTracked = async (value: string, body: () => Promise<void>): Promise<void> => {
    process.env[MAX_TRACKED] = value;
    try {
      await body();
    } finally {
      delete process.env[MAX_TRACKED];
    }
  };

  it("tracks at most CAMIS_ENDPOINT_MAX_TRACKED_CALLERS callers per endpoint; while full, the callers not tracked share one count, limited to the endpoint's rate", async () => {
    const at = clocks();
    await withMaxTracked("2", async () => {
      const middleware = stack();
      const from = (ip: string) => run(post("{}", {}, ip), middleware);
      for (let i = 0; i < 3; i += 1) expect((await from("192.0.2.1")).reached).toBe(true);
      expect((await from("192.0.2.1")).ctx.status).toBe(429);
      expect((await from("192.0.2.2")).reached).toBe(true);
      // Full: the callers not tracked make three requests a window between them, from however
      // many addresses they come.
      for (const ip of ["192.0.2.3", "192.0.2.4", "192.0.2.5"])
        expect((await from(ip)).reached).toBe(true);
      for (const ip of ["192.0.2.3", "192.0.2.6", "2001:db8:9::1"]) {
        const over = await from(ip);
        refused(over.ctx, 429, "RateLimitError");
        expect(Number(over.ctx.response["retry-after"])).toBeGreaterThan(0);
      }
      // A caller already tracked keeps its own count, the shared one spent.
      for (let i = 0; i < 2; i += 1) expect((await from("192.0.2.2")).reached).toBe(true);
      expect((await from("192.0.2.2")).ctx.status).toBe(429);
      // Another endpoint's counts are its own, so this endpoint's flood leaves them as they were.
      expect((await run(ping("192.0.2.7"), middleware)).reached).toBe(true);
      expect((await run(ping("192.0.2.7"), middleware)).ctx.status).toBe(429);
      expect((await run(ping("192.0.2.8"), middleware)).reached).toBe(true);
      // A minute on, the two counts have expired and make room for two new callers, each
      // counted apart; the next shares a fresh count.
      at.monotonic += 61_000;
      for (const ip of ["192.0.2.9", "192.0.2.10"]) {
        for (let i = 0; i < 3; i += 1) expect((await from(ip)).reached).toBe(true);
        expect((await from(ip)).ctx.status).toBe(429);
      }
      for (const ip of ["192.0.2.11", "192.0.2.12", "192.0.2.13"])
        expect((await from(ip)).reached).toBe(true);
      expect((await from("192.0.2.14")).ctx.status).toBe(429);
    });
  });

  it("frees an expired count's room for the next caller as it expires, the oldest first, while the cap is full", async () => {
    const at = clocks();
    await withMaxTracked("2", async () => {
      const middleware = stack();
      const from = (ip: string) => run(post("{}", {}, ip), middleware);
      const tracked = async (ip: string): Promise<void> => {
        for (let i = 0; i < 3; i += 1) expect((await from(ip)).reached).toBe(true);
        expect((await from(ip)).ctx.status).toBe(429);
      };
      await tracked("192.0.2.1");
      at.monotonic += 30_000;
      expect((await from("192.0.2.2")).reached).toBe(true);
      // The window turns and the first caller's count expires: it makes room at once.
      at.monotonic += 31_000;
      await tracked("192.0.2.3");
      // Full again, the second caller's count still running: the next caller shares.
      at.monotonic += 1_000;
      for (let i = 0; i < 3; i += 1) expect((await from("192.0.2.4")).reached).toBe(true);
      expect((await from("192.0.2.5")).ctx.status).toBe(429);
      // The second caller's count expires in its turn, and the first caller returning takes
      // its room, counted on its own again.
      at.monotonic += 29_000;
      await tracked("192.0.2.1");
      expect((await from("192.0.2.6")).ctx.status).toBe(429);
    });
  });

  it("serves new callers once a flood's counts expire, though the flood comes back every two minutes", async () => {
    const at = clocks();
    await withMaxTracked("100", async () => {
      const middleware = stack();
      let served = 0;
      for (let second = 0; second < 600; second += 1) {
        if (second % 120 === 0) {
          for (let i = 0; i < 100; i += 1)
            await run(post("{}", {}, `198.18.${second >> 2}.${i}`), middleware);
        }
        if ((await run(post("{}", {}, `10.1.${second >> 8}.${second & 255}`), middleware)).reached)
          served += 1;
        at.monotonic += 1_000;
      }
      // Only the first minute, while the flood's counts are running, shares one count.
      expect(served).toBeGreaterThanOrEqual(540);
    });
  });

  it("looks only at the oldest count to make room, never walking the callers", async () => {
    const at = clocks();
    await withMaxTracked("1000", async () => {
      const middleware = stack();
      for (let i = 0; i < 1_000; i += 1)
        await run(post("{}", {}, `10.2.${i >> 8}.${i & 255}`), middleware);
      at.monotonic += 61_000;
      const keys = vi.spyOn(Map.prototype, "keys");
      const iterate = vi.spyOn(Map.prototype, Symbol.iterator);
      const forEach = vi.spyOn(Map.prototype, "forEach");
      const values = vi.spyOn(Map.prototype, "values");
      const entries = vi.spyOn(Map.prototype, "entries");
      const remove = vi.spyOn(Map.prototype, "delete");
      for (let i = 0; i < 5; i += 1) await run(post("{}", {}, `172.16.1.${i}`), middleware);
      expect(keys.mock.calls.length).toBeLessThanOrEqual(5);
      expect(remove.mock.calls.length).toBeLessThanOrEqual(5);
      for (const spy of [iterate, forEach, values, entries]) expect(spy).not.toHaveBeenCalled();
    });
  });

  it("keeps no more than the cap of callers however many addresses come", async () => {
    clocks();
    await withMaxTracked("2", async () => {
      const middleware = stack();
      const set = vi.spyOn(Map.prototype, "set");
      for (let i = 0; i < 500; i += 1)
        await run(post("{}", {}, `10.0.${i >> 8}.${i & 255}`), middleware);
      const callers = set.mock.calls.filter(
        ([key]) => typeof key === "string" && /^[0-9a-f]{32}$/.test(key),
      );
      expect(callers).toHaveLength(2);
    });
  });

  it("reads CAMIS_ENDPOINT_MAX_TRACKED_CALLERS only in digits, never less than one", async () => {
    clocks();
    await withMaxTracked("0", async () => {
      const middleware = stack();
      expect((await run(ping("192.0.2.1"), middleware)).reached).toBe(true);
      expect((await run(ping("192.0.2.1"), middleware)).ctx.status).toBe(429);
      // Full at one: the next caller is in the shared count, at the endpoint's rate of one.
      expect((await run(ping("192.0.2.2"), middleware)).reached).toBe(true);
      expect((await run(ping("192.0.2.3"), middleware)).ctx.status).toBe(429);
    });
    for (const other of ["", "1e3", "-1", " 1", "abc"]) {
      await withMaxTracked(other, async () => {
        const middleware = stack();
        for (const ip of ["192.0.2.1", "192.0.2.2"]) {
          expect((await run(ping(ip), middleware)).reached).toBe(true);
          expect((await run(ping(ip), middleware)).ctx.status).toBe(429);
        }
      });
    }
  });

  it("forgets expired callers without walking every caller tracked", async () => {
    const at = clocks();
    const middleware = stack();
    for (let i = 0; i < 10_050; i += 1) {
      await run(post("{}", {}, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`), middleware);
    }
    at.monotonic += 61_000;
    const iterate = vi.spyOn(Map.prototype, Symbol.iterator);
    const forEach = vi.spyOn(Map.prototype, "forEach");
    const keys = vi.spyOn(Map.prototype, "keys");
    const values = vi.spyOn(Map.prototype, "values");
    const entries = vi.spyOn(Map.prototype, "entries");
    for (let i = 0; i < 5; i += 1) await run(post("{}", {}, `172.16.0.${i}`), middleware);
    for (const spy of [iterate, forEach, keys, values, entries]) expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A refusal leaving a body unread says Connection: close and, once sent, half-closes the
   * connection and drains what still comes, rather than destroy it under the answer.
   */
  const closes = (ctx: FakeContext): void => {
    expect(ctx.response.connection).toBe("close");
    const req = ctx.req;
    ctx.res.emit("finish");
    expect(req.socket.ended).toBe(true);
    expect(req.socket.destroyed).toBe(false);
    expect(req.destroyed).toBe(false);
    req.socket.emit("end");
    expect(req.socket.destroyed).toBe(true);
  };

  it("closes the connection after any refusal that leaves a body unread, and keeps it after one with no body", async () => {
    const middleware = stack();
    for (let i = 0; i < 3; i += 1) await run(post("{}"), middleware);
    closes((await run(post("{}"), middleware)).ctx);
    closes((await run(post("<a/>", { "Content-Type": "application/xml" }))).ctx);
    const pings = stack();
    await run(context("GET", "/api/articles/ping"), pings);
    const bodiless = await run(context("GET", "/api/articles/ping"), pings);
    expect(bodiless.ctx.status).toBe(429);
    expect(bodiless.ctx.response.connection).toBeUndefined();
  });

  it("drops a request read after a refusal on the same connection, unanswered and unprocessed, in both middlewares", async () => {
    const middleware = stack();
    const first = (await run(post("{}", { "Content-Length": "100000" }), middleware)).ctx;
    expect(first.status).toBe(413);
    const socket = first.req.socket;
    const behind = (ctx: FakeContext): FakeContext => {
      ctx.req.socket = socket;
      return ctx;
    };
    const other = await run(behind(context("GET", "/api/articles")), middleware);
    expect(other.reached).toBe(false);
    expect(other.ctx.respond).toBe(false);
    expect(other.ctx.status).toBe(404);
    expect(other.ctx.response).toEqual({});
    // A preflight the cross-origin middleware would answer itself.
    const preflight = await run(
      behind(
        context("OPTIONS", "/api/articles/7/ingest", {
          Origin: "https://site.example",
          "Access-Control-Request-Method": "POST",
        }),
      ),
      middleware,
    );
    expect(preflight.ctx.respond).toBe(false);
    expect(preflight.ctx.status).toBe(404);
    expect(preflight.ctx.response).toEqual({});
    // The guards' middleware alone, the first of the two in a project with no cross-origin endpoint.
    const alone = await run(behind(context("GET", "/api/articles")), guardsFactory({}, { strapi }));
    expect(alone.reached).toBe(false);
    expect(alone.ctx.respond).toBe(false);
    // Nothing is destroyed early, which would reset the connection under the refusal.
    expect(socket.destroyed).toBe(false);
    expect(socket.ended).toBe(false);
    const fresh = await run(context("GET", "/api/articles"), middleware);
    expect(fresh.reached).toBe(true);
    expect(fresh.ctx.respond).toBeUndefined();
  });

  /** Waits until the refused request's body stops flowing: paused, or all of it read. */
  const settled = (ctx: FakeContext): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (ctx.req.readableFlowing === false || ctx.req.readableEnded) resolve();
        else setImmediate(check);
      };
      setImmediate(check);
    });
  const declared = (pieces: number): FakeContext => {
    const piece = Buffer.alloc(64 * 1024, 120);
    return context(
      "POST",
      "/api/articles/7/ingest",
      { "Content-Type": "application/json", "Content-Length": String(pieces * piece.length) },
      new Array<Buffer>(pieces).fill(piece),
    );
  };

  it("stops reading the refused body once more than 1 MiB of it has been drained, as it is read, and drops the connection after 2 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const request = declared(40);
      const emit = vi.spyOn(request.req, "emit");
      const large = (await run(request)).ctx;
      expect(large.status).toBe(413);
      large.res.emit("finish");
      await settled(large);
      const drained = emit.mock.calls
        .filter(([event]) => event === "data")
        .reduce((sum, [, chunk]) => sum + (chunk as Buffer).length, 0);
      // Stopped on the 64 KiB piece that takes it past 1 MiB, not after the whole 2.5 MiB, and
      // the connection kept, so no reset can beat the answer to the client.
      expect(drained).toBe(17 * 64 * 1024);
      expect(large.req.readableEnded).toBe(false);
      expect(large.req.socket.destroyed).toBe(false);
      vi.advanceTimersByTime(1_999);
      expect(large.req.socket.destroyed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(large.req.socket.destroyed).toBe(true);
      // Less than that is drained whole, and the connection waits for the client's end.
      const small = (await run(declared(8))).ctx;
      small.res.emit("finish");
      await settled(small);
      expect(small.req.readableEnded).toBe(true);
      expect(small.req.socket.destroyed).toBe(false);
      small.req.socket.emit("end");
      expect(small.req.socket.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses another media type with 415, and a body with none", async () => {
    refused(
      (await run(post("a=1", { "Content-Type": "application/x-www-form-urlencoded" }))).ctx,
      415,
      "UnsupportedMediaTypeError",
    );
    const untyped = post("{}");
    delete untyped.req.headers["content-type"];
    refused((await run(untyped)).ctx, 415, "UnsupportedMediaTypeError");
  });

  it("refuses with 413 a body declared too large, unread, and closes the connection", async () => {
    const { ctx, reached } = await run(post("{}", { "Content-Length": "100000" }));
    expect(reached).toBe(false);
    refused(ctx, 413, "PayloadTooLargeError");
    closes(ctx);
  });

  it("counts the bytes of a body sent without a length, refusing one too large and closing the connection, and passing the rest on whole", async () => {
    // Sent in chunks, the rest still to come when the limit is passed.
    const chunked = (...chunks: string[]) =>
      context(
        "POST",
        "/api/articles/7/ingest",
        { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
        chunks.map((c) => Buffer.from(c)),
      );
    const large = await run(chunked("x".repeat(65), "y".repeat(1000)));
    expect(large.reached).toBe(false);
    refused(large.ctx, 413, "PayloadTooLargeError");
    closes(large.ctx);
    const small = await run(chunked("x".repeat(30), "x".repeat(34)));
    expect(small.seen).toBe("x".repeat(64));
    expect(small.ctx.req.headers["content-length"]).toBe("64");
    expect(small.ctx.req.headers["transfer-encoding"]).toBeUndefined();
    expect(small.ctx.request.req).toBe(small.ctx.req);
    expect(small.ctx.response.connection).toBeUndefined();
  });
});

// Both middlewares behind a real HTTP server, as Koa drives them, and clients that go on sending
// after they are refused: the refusal must reach them every time, not be lost to a reset that
// discards the answer still queued, and nothing they send after it on that connection may be
// processed.
describe("strapi endpoint guards: a refusal over a real connection", () => {
  let dir = "";
  let server: Server;
  let port = 0;
  /** The requests the handler behind both middlewares ran for. */
  const handled: string[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "camis-endpoint-socket-"));
    const load = async (path: string, name: string) => {
      const target = join(dir, name);
      writeFileSync(target, file(guarded, path)!.content);
      const factory = ((await import(pathToFileURL(target).href)) as { default: Factory }).default;
      return factory({}, { strapi }) as unknown as (
        ctx: Record<string, unknown>,
        next: () => Promise<void>,
      ) => Promise<void>;
    };
    // A rate no run reaches, the size alone refusing.
    process.env.CAMIS_ENDPOINT_ARTICLE_INGEST_THROTTLE_PER_MINUTE = "100000";
    const guards = await load(MIDDLEWARE, "camis_endpoint_guards.ts");
    const cors = await load(CORS_MIDDLEWARE, "camis_endpoint_cors.ts");
    server = createServer((req, res) => {
      const ctx: Record<string, unknown> = {
        method: req.method,
        path: new URL(req.url ?? "/", "http://localhost").pathname,
        req,
        res,
        request: { ip: req.socket.remoteAddress ?? "", req },
        status: 404,
        body: undefined,
        get: (name: string) => {
          const value = req.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(", ") : (value ?? "");
        },
        set: (name: string, value: string) => res.setHeader(name, value),
        remove: (name: string) => res.removeHeader(name),
      };
      void cors(ctx, () =>
        guards(ctx, () => {
          handled.push(`${req.method ?? ""} ${req.url ?? ""}`);
          ctx.status = 200;
          ctx.body = { data: "reached" };
          return Promise.resolve();
        }),
      ).then(() => {
        // As Koa does: a middleware that set respond to false answers itself, or not at all.
        if (ctx.respond === false) return;
        res.statusCode = ctx.status as number;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(ctx.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    delete process.env.CAMIS_ENDPOINT_ARTICLE_INGEST_THROTTLE_PER_MINUTE;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const BODY = 50 * 1024 * 1024;
  const head = (chunked: boolean, length = BODY): string =>
    [
      "POST /api/articles/7/ingest HTTP/1.1",
      "Host: localhost",
      "Content-Type: application/json",
      chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${length}`,
      "",
      "",
    ].join("\r\n");

  // What a client sees of the connection after it is refused mid-body: whether the server shut its
  // side cleanly (end) or reset it (error), and when the connection closed, the client going on
  // sending a little at a time and never ending.
  const lingered = (chunked: boolean) =>
    new Promise<{ status: string; ended: boolean; reset: boolean; closedAfter: number }>(
      (resolve) => {
        const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
        let received = "";
        let ended = false;
        let reset = false;
        let answeredAt = 0;
        let trickle: NodeJS.Timeout | undefined;
        socket.on("data", (data: Buffer) => {
          received += data.toString("latin1");
          if (answeredAt === 0) answeredAt = Date.now();
        });
        socket.on("end", () => (ended = true));
        socket.on("error", () => (reset = true));
        const timer = setTimeout(() => socket.destroy(), 8_000);
        socket.on("close", () => {
          clearInterval(trickle);
          clearTimeout(timer);
          resolve({
            status: received.split("\r\n")[0] ?? "",
            ended,
            reset: reset && !ended,
            closedAfter: Date.now() - answeredAt,
          });
        });
        socket.on("connect", () => {
          const piece = Buffer.alloc(256 * 1024, 120);
          socket.write(head(chunked) + (chunked ? `${piece.length.toString(16)}\r\n` : ""));
          socket.write(piece);
          const byte = chunked ? Buffer.from("\r\n1\r\nx") : Buffer.from("x");
          trickle = setInterval(() => {
            if (!socket.destroyed) socket.write(byte);
          }, 100);
        });
      },
    );

  it.each([
    ["declared", false],
    ["chunked", true],
  ])(
    "after refusing a %s body, shuts its side and drains what comes for a bounded time, never resetting under the answer",
    async (_kind, chunked) => {
      const seen = await lingered(chunked);
      expect(seen.status).toBe("HTTP/1.1 413 Payload Too Large");
      expect(seen.ended).toBe(true);
      expect(seen.reset).toBe(false);
      expect(seen.closedAfter).toBeGreaterThan(1_500);
      expect(seen.closedAfter).toBeLessThan(6_000);
    },
    20_000,
  );

  // A client pipelining requests behind one refused with its body unread: a GET elsewhere, a
  // preflight the cross-origin middleware would answer, and a POST the guards would let through.
  const pipelined = (chunked: boolean) =>
    new Promise<{ received: string; ended: boolean; reset: boolean }>((resolve) => {
      const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
      let received = "";
      let ended = false;
      let reset = false;
      socket.on("data", (data: Buffer) => (received += data.toString("latin1")));
      socket.on("end", () => {
        ended = true;
        socket.end();
      });
      socket.on("error", () => (reset = true));
      const timer = setTimeout(() => socket.destroy(), 8_000);
      socket.on("close", () => {
        clearTimeout(timer);
        resolve({ received, ended, reset: reset && !ended });
      });
      socket.on("connect", () => {
        const refused = chunked
          ? `${head(true)}41\r\n${"x".repeat(65)}\r\n0\r\n\r\n`
          : `${head(false, 100)}${"x".repeat(100)}`;
        socket.write(
          refused +
            "GET /api/articles HTTP/1.1\r\nHost: localhost\r\n\r\n" +
            "OPTIONS /api/articles/7/ingest HTTP/1.1\r\nHost: localhost\r\nOrigin: https://site.example\r\nAccess-Control-Request-Method: POST\r\n\r\n" +
            `${head(false, 2)}{}`,
        );
      });
    });

  it.each([
    ["declared", false],
    ["chunked", true],
  ])(
    "processes nothing pipelined behind a refused %s body, and still answers the refusal and closes cleanly",
    async (_kind, chunked) => {
      handled.length = 0;
      const seen = await pipelined(chunked);
      // Time for a request still being handled to finish, were one handled at all.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(seen.received.split("\r\n")[0]).toBe("HTTP/1.1 413 Payload Too Large");
      expect(seen.received.match(/HTTP\/1\.1 /g)).toHaveLength(1);
      expect(seen.ended).toBe(true);
      expect(seen.reset).toBe(false);
      expect(handled).toEqual([]);
    },
    20_000,
  );

  // A client streaming a 50 MB body in a process of its own (scripts/streaming-client.mjs), as a
  // real client is: the server's reset reaches it while the answer may still be unread.
  const CLIENT = fileURLToPath(new URL("../../scripts/streaming-client.mjs", import.meta.url));
  const RUNS = 10;
  const streamed = async (chunked: boolean): Promise<string[]> => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [CLIENT, String(port), chunked ? "chunked" : "declared", String(RUNS)],
      { timeout: 100_000 },
    );
    return stdout.trim().split("\n");
  };

  it.each([
    ["declared", false],
    ["chunked", true],
  ])(
    "answers a %s body over its size with 413 every time, to a client in another process",
    async (_kind, chunked) => {
      expect(await streamed(chunked)).toEqual(
        new Array<string>(RUNS).fill("HTTP/1.1 413 Payload Too Large"),
      );
    },
    120_000,
  );
});
