import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TS_MARKER } from "@camis/adapter-kernel";
import type { Endpoint, IrDocument } from "@camis/ir-schema";
import { strapiAdapter } from "../generate";
import { importEndpoints } from "../import/endpoints";
import { importDocument } from "../import/import-document";
import { customCodeDoc } from "../__fixtures__/custom-code";

// An endpoint's declared guards, checked by a generated global middleware ahead of strapi::cors
// and strapi::body, so a refused body is never parsed and the app's CORS never answers for it.
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
const guarded = generate(guardedDoc(ingest, ping));
const file = (result: ReturnType<typeof generate>, path: string) =>
  result.files.find((f) => f.path === path);
const MIDDLEWARE = "src/middlewares/camis_endpoint_guards.ts";

describe("strapi endpoint guards: the generated project", () => {
  it("runs the guards as a global middleware after strapi::errors and ahead of strapi::cors and strapi::body", async () => {
    const config = file(guarded, "config/middlewares.ts")!.content;
    await expect(config).toMatchFileSnapshot("./__golden__/middlewares.guarded.ts.txt");
    expect(config.indexOf("'global::camis_endpoint_guards'")).toBeGreaterThan(
      config.indexOf("'strapi::errors'"),
    );
    expect(config.indexOf("'global::camis_endpoint_guards'")).toBeLessThan(
      config.indexOf("'strapi::cors'"),
    );
  });

  it("generates the middleware, marked as generated", async () => {
    const middleware = file(guarded, MIDDLEWARE)!;
    expect(middleware.mode).toBeUndefined();
    expect(middleware.content.startsWith(TS_MARKER)).toBe(true);
    await expect(middleware.content).toMatchFileSnapshot(
      "./__golden__/camis_endpoint_guards.ts.txt",
    );
  });

  it("leaves a project whose endpoints have no guard as it was", () => {
    const plain = generate(customCodeDoc);
    expect(file(plain, MIDDLEWARE)).toBeUndefined();
    expect(file(plain, "config/middlewares.ts")!.content).not.toContain("camis_endpoint_guards");
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
    expect(importEndpoints(routes, guardedDoc(ingest, ping)).endpoints).toEqual([
      ...(customCodeDoc.endpoints ?? []),
      route,
      {
        name: ping.name,
        contentType: ping.contentType,
        method: "GET",
        path: ping.path,
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

/** A Koa context as the middleware reads and writes it. */
interface FakeContext {
  method: string;
  path: string;
  req: Readable & { headers: Record<string, string>; socket: object; method: string; url: string };
  request: { ip: string; req?: unknown };
  status: number;
  body: unknown;
  response: Record<string, string>;
  get(name: string): string;
  set(name: string, value: string): void;
  remove(name: string): void;
}

type Middleware = (ctx: FakeContext, next: () => Promise<void>) => Promise<void>;
type Factory = (config: unknown, deps: { strapi: unknown }) => Middleware;

// Strapi's config as a new project has it: every key at its default.
const strapi = { config: { get: (_key: string, fallback: unknown) => fallback } };

const context = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body: Buffer | undefined = undefined,
  ip = "203.0.113.7",
): FakeContext => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const socket = {};
  const req = Object.assign(Readable.from(body === undefined ? [] : [body]), {
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

describe("strapi endpoint guards: the generated middleware at work", () => {
  let dir = "";
  let factory: Factory;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "camis-endpoint-guards-"));
    const path = join(dir, "camis_endpoint_guards.ts");
    writeFileSync(path, file(guarded, MIDDLEWARE)!.content);
    factory = ((await import(pathToFileURL(path).href)) as { default: Factory }).default;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs one request through a fresh middleware; next() stands for the rest of Strapi. */
  const run = async (
    ctx: FakeContext,
    middleware: Middleware = factory({}, { strapi }),
  ): Promise<{ ctx: FakeContext; reached: boolean; seen: string | undefined }> => {
    let reached = false;
    let seen: string | undefined;
    await middleware(ctx, async () => {
      reached = true;
      seen = await readAll(ctx.req);
      // strapi::cors answering as the app's CORS does for a listed origin.
      ctx.set("Access-Control-Allow-Origin", ctx.get("Origin"));
      ctx.set("Access-Control-Allow-Credentials", "true");
      ctx.status = 200;
      ctx.body = { data: seen };
    });
    return { ctx, reached, seen };
  };
  const post = (body: string, headers: Record<string, string> = {}) =>
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
    );
  const openToAnyOrigin = (ctx: FakeContext): void => {
    expect(ctx.response["access-control-allow-origin"]).toBe("*");
    expect(ctx.response["access-control-allow-credentials"]).toBeUndefined();
    expect(ctx.response["access-control-expose-headers"]).toBe("Retry-After");
  };
  const refused = (ctx: FakeContext, status: number, name: string): void => {
    expect(ctx.status).toBe(status);
    expect(ctx.body).toEqual({
      data: null,
      error: { status, name, message: expect.any(String) as string, details: {} },
    });
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
    });
  });

  it("leaves another method's preflight, and every other path, to the app's CORS", async () => {
    const other = await run(
      context("OPTIONS", "/api/articles/7/ingest", { "Access-Control-Request-Method": "PUT" }),
    );
    expect(other.reached).toBe(true);
    const elsewhere = await run(
      context("GET", "/api/articles", { Origin: "https://site.example" }),
    );
    expect(elsewhere.reached).toBe(true);
    expect(elsewhere.ctx.response["access-control-allow-credentials"]).toBe("true");
  });

  it("matches the path as Strapi's router does: any case, a trailing slash, a param as one segment", async () => {
    const middleware = factory({}, { strapi });
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
    const middleware = factory({}, { strapi });
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
      factory({}, { strapi })(ctx, () => {
        ctx.set("Access-Control-Allow-Credentials", "true");
        return Promise.reject(new Error("handler failed"));
      }),
    ).rejects.toThrow("handler failed");
    openToAnyOrigin(ctx);
  });

  it("refuses a caller over the throttle with 429 and Retry-After, counting refused requests, per address", async () => {
    const middleware = factory({}, { strapi });
    expect(
      (await run(post("<a/>", { "Content-Type": "application/xml" }), middleware)).ctx.status,
    ).toBe(415);
    expect((await run(post("{}"), middleware)).reached).toBe(true);
    expect((await run(post("{}"), middleware)).reached).toBe(true);
    const over = await run(post("{}"), middleware);
    expect(over.reached).toBe(false);
    refused(over.ctx, 429, "RateLimitError");
    expect(Number(over.ctx.response["retry-after"])).toBeGreaterThan(0);
    const another = post("{}");
    another.request.ip = "198.51.100.1";
    expect((await run(another, middleware)).reached).toBe(true);
  });

  it("counts each endpoint in a bucket of its own, a GET's HEAD in the GET's", async () => {
    const middleware = factory({}, { strapi });
    for (let i = 0; i < 3; i += 1) expect((await run(post("{}"), middleware)).reached).toBe(true);
    const pinged = await run(context("GET", "/api/articles/ping"), middleware);
    expect(pinged.reached).toBe(true);
    const head = await run(context("HEAD", "/api/articles/ping"), middleware);
    expect(head.reached).toBe(false);
    expect(head.ctx.status).toBe(429);
  });

  it("takes a deployment's own rate from the endpoint's variable, never less than one", async () => {
    process.env.CAMIS_ENDPOINT_ARTICLE_INGEST_THROTTLE_PER_MINUTE = "1";
    try {
      const middleware = factory({}, { strapi });
      expect((await run(post("{}"), middleware)).reached).toBe(true);
      expect((await run(post("{}"), middleware)).ctx.status).toBe(429);
      process.env.CAMIS_ENDPOINT_ARTICLE_INGEST_THROTTLE_PER_MINUTE = "0";
      const floored = factory({}, { strapi });
      expect((await run(post("{}"), floored)).reached).toBe(true);
      expect((await run(post("{}"), floored)).ctx.status).toBe(429);
    } finally {
      delete process.env.CAMIS_ENDPOINT_ARTICLE_INGEST_THROTTLE_PER_MINUTE;
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

  it("refuses with 413 a body declared too large, unread", async () => {
    const { ctx, reached } = await run(post("{}", { "Content-Length": "100000" }));
    expect(reached).toBe(false);
    refused(ctx, 413, "PayloadTooLargeError");
  });

  it("counts the bytes of a body sent without a length, refusing one too large and passing the rest on whole", async () => {
    const chunked = (body: string) => {
      const ctx = post(body, { "Transfer-Encoding": "chunked" });
      delete ctx.req.headers["content-length"];
      return ctx;
    };
    const large = await run(chunked("x".repeat(65)));
    expect(large.reached).toBe(false);
    refused(large.ctx, 413, "PayloadTooLargeError");
    const small = await run(chunked("x".repeat(64)));
    expect(small.seen).toBe("x".repeat(64));
    expect(small.ctx.req.headers["content-length"]).toBe("64");
    expect(small.ctx.req.headers["transfer-encoding"]).toBeUndefined();
    expect(small.ctx.request.req).toBe(small.ctx.req);
  });
});
