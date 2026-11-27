import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
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

  it("tracks at most CAMIS_ENDPOINT_MAX_TRACKED_CALLERS callers per endpoint, admitting a new one untracked when full", async () => {
    clocks();
    await withMaxTracked("2", async () => {
      const middleware = stack();
      for (let i = 0; i < 3; i += 1)
        expect((await run(post("{}", {}, "192.0.2.1"), middleware)).reached).toBe(true);
      expect((await run(post("{}", {}, "192.0.2.1"), middleware)).ctx.status).toBe(429);
      expect((await run(post("{}", {}, "192.0.2.2"), middleware)).reached).toBe(true);
      // Full: a new caller is let through, uncounted, however often it comes.
      for (let i = 0; i < 6; i += 1)
        expect((await run(post("{}", {}, "192.0.2.3"), middleware)).reached).toBe(true);
      // A caller already tracked is still counted and refused.
      expect((await run(post("{}", {}, "192.0.2.1"), middleware)).ctx.status).toBe(429);
      for (let i = 0; i < 2; i += 1)
        expect((await run(post("{}", {}, "192.0.2.2"), middleware)).reached).toBe(true);
      expect((await run(post("{}", {}, "192.0.2.2"), middleware)).ctx.status).toBe(429);
      // Another endpoint tracks its own callers, so one endpoint's flood leaves it its room.
      expect((await run(ping("192.0.2.3"), middleware)).reached).toBe(true);
      expect((await run(ping("192.0.2.3"), middleware)).ctx.status).toBe(429);
    });
  });

  it("reads CAMIS_ENDPOINT_MAX_TRACKED_CALLERS only in digits, never less than one", async () => {
    clocks();
    await withMaxTracked("0", async () => {
      const middleware = stack();
      expect((await run(ping("192.0.2.1"), middleware)).reached).toBe(true);
      expect((await run(ping("192.0.2.1"), middleware)).ctx.status).toBe(429);
      expect((await run(ping("192.0.2.2"), middleware)).reached).toBe(true);
      expect((await run(ping("192.0.2.2"), middleware)).reached).toBe(true);
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

// The guards' middleware behind a real HTTP server, as Koa drives it, and a client that goes on
// streaming a large body after it is refused: the refusal must reach it every time, not be lost to
// a reset that discards the answer still queued.
describe("strapi endpoint guards: a refusal over a real connection", () => {
  let dir = "";
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "camis-endpoint-socket-"));
    const target = join(dir, "camis_endpoint_guards.ts");
    writeFileSync(target, file(guarded, MIDDLEWARE)!.content);
    const factory = ((await import(pathToFileURL(target).href)) as { default: Factory }).default;
    // A rate no run reaches, the size alone refusing.
    process.env.CAMIS_ENDPOINT_ARTICLE_INGEST_THROTTLE_PER_MINUTE = "100000";
    const middleware = factory({}, { strapi }) as unknown as (
      ctx: Record<string, unknown>,
      next: () => Promise<void>,
    ) => Promise<void>;
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
      void middleware(ctx, () => {
        ctx.status = 200;
        ctx.body = { data: "reached" };
        return Promise.resolve();
      }).then(() => {
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
  /** What a client streaming a 50 MB body reads back before the connection ends. */
  const stream = (chunked: boolean): Promise<string> =>
    new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      const piece = Buffer.alloc(64 * 1024, 120);
      const framed = chunked
        ? Buffer.concat([
            Buffer.from(`${piece.length.toString(16)}\r\n`),
            piece,
            Buffer.from("\r\n"),
          ])
        : piece;
      let received = "";
      let sent = 0;
      let open = true;
      const pump = (): void => {
        while (open && sent < BODY) {
          sent += piece.length;
          if (!socket.write(framed)) {
            socket.once("drain", pump);
            return;
          }
        }
        if (open) socket.end(chunked ? "0\r\n\r\n" : "");
      };
      const timer = setTimeout(() => socket.destroy(), 15_000);
      socket.on("data", (data: Buffer) => (received += data.toString("latin1")));
      socket.on("error", () => undefined);
      socket.on("close", () => {
        open = false;
        clearTimeout(timer);
        resolve(received);
      });
      socket.on("connect", () => {
        socket.write(
          [
            "POST /api/articles/7/ingest HTTP/1.1",
            "Host: localhost",
            "Content-Type: application/json",
            chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${BODY}`,
            "",
            "",
          ].join("\r\n"),
        );
        pump();
      });
    });

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
          socket.write(
            [
              "POST /api/articles/7/ingest HTTP/1.1",
              "Host: localhost",
              "Content-Type: application/json",
              chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${BODY}`,
              "",
              chunked ? `${piece.length.toString(16)}\r\n` : "",
            ].join("\r\n"),
          );
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

  it.each([
    ["declared", false],
    ["chunked", true],
  ])(
    "answers a %s body over its size with 413 every time",
    async (_kind, chunked) => {
      const answers: string[] = [];
      for (let run = 0; run < 20; run += 1)
        answers.push((await stream(chunked)).split("\r\n")[0] ?? "");
      expect(answers).toEqual(new Array<string>(20).fill("HTTP/1.1 413 Payload Too Large"));
    },
    120_000,
  );
});
