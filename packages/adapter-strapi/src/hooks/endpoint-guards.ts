import {
  endpointThrottleEnv,
  isGuardedEndpoint,
  withMarker,
  type GeneratedFile,
} from "@camis/adapter-kernel";
import type { CapabilityGap, Endpoint, IrDocument } from "@camis/ir-schema";

/**
 * The global middleware's name: an underscore, which no IR route middleware's file name (a kebab
 * slug of a PascalCase name) has, so it never meets one in src/middlewares.
 */
export const ENDPOINT_GUARDS_MIDDLEWARE = "camis_endpoint_guards";

const guardedEndpoints = (doc: IrDocument): Endpoint[] =>
  (doc.endpoints ?? []).filter(isGuardedEndpoint).sort((a, b) => a.name.localeCompare(b.name));

/** Whether the project runs the endpoint guards' global middleware. */
export const hasEndpointGuards = (doc: IrDocument): boolean => guardedEndpoints(doc).length > 0;

const json = (value: string): string => JSON.stringify(value);
const list = (items: string[]): string => `[${items.map(json).join(", ")}]`;

const guardEntry = (e: Endpoint): string => {
  const keys = [
    `name: ${json(e.name)}`,
    `method: ${json(e.method)}`,
    `path: ${json(e.path)}`,
    ...(e.throttle === undefined
      ? []
      : [
          `throttle: { perMinute: ${e.throttle.perMinute}, env: ${json(endpointThrottleEnv(e.name))} }`,
        ]),
    ...(e.maxBodyBytes === undefined ? [] : [`maxBodyBytes: ${e.maxBodyBytes}`]),
    ...(e.accepts === undefined ? [] : [`accepts: ${list(e.accepts.map((t) => t.toLowerCase()))}`]),
    ...(e.crossOrigin === undefined ? [] : [`crossOriginHeaders: ${list(e.crossOrigin.headers)}`]),
  ];
  return `  {\n${keys.map((k) => `    ${k},`).join("\n")}\n  },`;
};

// The middleware's code, the same in every project; only GUARDS above it differs.
const RUNTIME = `
const MAX_AGE = "7200";
const MINUTE = 60_000;

interface Refusal {
  status: number;
  name: string;
  message: string;
}
const TOO_MANY: Refusal = {
  status: 429,
  name: "RateLimitError",
  message: "Too many requests, please try again later.",
};
const TOO_LARGE: Refusal = { status: 413, name: "PayloadTooLargeError", message: "Entity too large" };

const escape = (text: string): string => text.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");

// Strapi's router (@koa/router) matches a route case-insensitively, with or without a trailing
// slash, and a :param as one segment of the raw path; the guards match it the same way, so no
// spelling of the path reaches the endpoint around them. A GET route answers HEAD too.
const matcher = (prefix: string, guard: Guard): RegExp =>
  new RegExp(\`^\${escape(prefix + guard.path).replace(/:[A-Za-z0-9_-]+/g, "[^/]+")}/?$\`, "i");

const methods = (guard: Guard): string[] =>
  guard.method === "GET" ? ["GET", "HEAD"] : [guard.method];

// What (int) reads in PHP, so both targets take one value alike: unset is the IR's rate, anything
// else its leading digits, and never less than one a minute.
const rate = (throttle: Throttle): number => {
  const raw = process.env[throttle.env];
  if (raw === undefined) return throttle.perMinute;
  const read = Number.parseInt(raw, 10);
  return Math.max(1, Number.isNaN(read) ? 0 : read);
};

const mediaType = (header: string): string => (header.split(";")[0] ?? "").trim().toLowerCase();

const hasBody = (ctx: Context): boolean => {
  const length = ctx.get("Content-Length");
  return (length !== "" && length !== "0") || ctx.get("Transfer-Encoding") !== "";
};

const refuse = (ctx: Context, refusal: Refusal): void => {
  ctx.status = refusal.status;
  // Strapi's error body, as strapi::errors writes it.
  ctx.body = {
    data: null,
    error: { status: refusal.status, name: refusal.name, message: refusal.message, details: {} },
  };
};

const openToAnyOrigin = (ctx: Context): void => {
  ctx.set("Access-Control-Allow-Origin", "*");
  ctx.set("Access-Control-Expose-Headers", "Retry-After");
  ctx.remove("Access-Control-Allow-Credentials");
};

/** The body read up to one byte past the limit: null once it passes it. */
const readAtMost = (req: Context["req"], max: number): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) {
        done();
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      done();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      done();
      reject(error);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });

/**
 * The request again, its body the bytes already read, with the length they have: strapi::body and
 * the handler read it as they read any request, and everything else is the request's own.
 */
const replay = (ctx: Context, body: Buffer): void => {
  const original = ctx.req;
  const headers = { ...original.headers, "content-length": String(body.length) };
  delete headers["transfer-encoding"];
  const replayed = Object.assign(Readable.from([body]), {
    headers,
    rawHeaders: original.rawHeaders,
    method: original.method,
    url: original.url,
    httpVersion: original.httpVersion,
    httpVersionMajor: original.httpVersionMajor,
    httpVersionMinor: original.httpVersionMinor,
    socket: original.socket,
    connection: original.socket,
    trailers: original.trailers,
  });
  ctx.req = replayed as unknown as Context["req"];
  ctx.request.req = ctx.req;
};

/**
 * Strapi's own throttles (users-permissions' koa2-ratelimit) count in the process's memory, and so
 * does this: with more than one Strapi process each counts apart. The caller's address is kept only
 * as the counter's key, hashed.
 */
const counter = () => {
  const counts = new Map<string, { count: number; resetAt: number }>();
  return (key: string, max: number): number | null => {
    const now = Date.now();
    if (counts.size > 10_000) {
      for (const [k, entry] of counts) if (entry.resetAt <= now) counts.delete(k);
    }
    let entry = counts.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + MINUTE };
      counts.set(key, entry);
    }
    entry.count += 1;
    return entry.count > max ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : null;
  };
};

/**
 * The IR endpoints' declared guards, in this order, before strapi::cors, strapi::body and the
 * route: a browser's preflight is answered; then a caller over the throttle (refused requests
 * count too), a body of another media type (parameters ignored) and a body over its size (by its
 * Content-Length, or by the bytes read when it has none: Node reads no more than a declared length)
 * are refused, each in Strapi's error body. An endpoint answering browsers on any origin opens
 * every answer, refusals and errors included, to any origin without credentials: strapi::cors still
 * runs for it after these checks, and its headers are replaced on the way out.
 */
export default (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  const prefix = String(strapi.config.get("api.rest.prefix", "/api"));
  const routes = GUARDS.map((guard) => ({ guard, pattern: matcher(prefix, guard), methods: methods(guard) }));
  const take = counter();

  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const onPath = routes.filter((route) => route.pattern.test(ctx.path));
    if (onPath.length === 0) return next();
    const asked = ctx.get("Access-Control-Request-Method").toUpperCase();
    if (ctx.method === "OPTIONS" && asked !== "") {
      const answered = onPath.find((route) => route.guard.crossOriginHeaders !== undefined && route.methods.includes(asked));
      if (answered === undefined) return next();
      openToAnyOrigin(ctx);
      ctx.set("Access-Control-Allow-Methods", answered.guard.method);
      const headers = answered.guard.crossOriginHeaders ?? [];
      if (headers.length > 0) ctx.set("Access-Control-Allow-Headers", headers.join(", "));
      ctx.set("Access-Control-Max-Age", MAX_AGE);
      ctx.status = 204;
      return;
    }
    const guard = onPath.find((route) => route.methods.includes(ctx.method))?.guard;
    if (guard === undefined) return next();
    const crossOrigin = guard.crossOriginHeaders !== undefined;
    if (crossOrigin) openToAnyOrigin(ctx);

    if (guard.throttle !== undefined) {
      const address = createHash("sha256").update(String(ctx.request.ip)).digest("hex").slice(0, 32);
      const wait = take(address, rate(guard.throttle));
      if (wait !== null) {
        ctx.set("Retry-After", String(wait));
        return refuse(ctx, TOO_MANY);
      }
    }
    if (guard.accepts !== undefined) {
      const type = ctx.get("Content-Type");
      const accepted = type === "" ? !hasBody(ctx) : guard.accepts.includes(mediaType(type));
      if (!accepted) {
        return refuse(ctx, {
          status: 415,
          name: "UnsupportedMediaTypeError",
          message: \`The request body must be \${guard.accepts.join(" or ")}\`,
        });
      }
    }
    if (guard.maxBodyBytes !== undefined) {
      const declared = ctx.get("Content-Length");
      if (/^\\d+$/.test(declared)) {
        if (declared.replace(/^0+/, "").length > 15 || Number(declared) > guard.maxBodyBytes) return refuse(ctx, TOO_LARGE);
      } else if (ctx.get("Transfer-Encoding") !== "") {
        const body = await readAtMost(ctx.req, guard.maxBodyBytes);
        if (body === null) return refuse(ctx, TOO_LARGE);
        replay(ctx, body);
      }
    }

    if (!crossOrigin) return next();
    try {
      await next();
    } finally {
      openToAnyOrigin(ctx);
    }
  };
};
`;

const HEAD = `import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { Core } from "@strapi/strapi";

interface Throttle {
  perMinute: number;
  /** The variable a deployment overrides the rate with. */
  env: string;
}

interface Guard {
  name: string;
  method: string;
  /** Under the content API's prefix, Strapi's form. */
  path: string;
  throttle?: Throttle;
  maxBodyBytes?: number;
  accepts?: string[];
  crossOriginHeaders?: string[];
}

/** What the middleware reads of Koa's context. */
interface Context {
  method: string;
  path: string;
  req: IncomingMessage;
  request: { ip: string; req: IncomingMessage };
  status: number;
  body: unknown;
  get(field: string): string;
  set(field: string, value: string): void;
  remove(field: string): void;
}
`;

const middleware = (guarded: Endpoint[]): string =>
  withMarker(`${HEAD}
// Each guarded IR endpoint's guards.
const GUARDS: Guard[] = [
${guarded.map(guardEntry).join("\n")}
];
${RUNTIME}`);

/** The guards' global middleware, for a project with a guarded endpoint. */
export const emitEndpointGuardFiles = (doc: IrDocument): GeneratedFile[] => {
  const guarded = guardedEndpoints(doc);
  return guarded.length === 0
    ? []
    : [
        {
          path: `src/middlewares/${ENDPOINT_GUARDS_MIDDLEWARE}.ts`,
          content: middleware(guarded),
        },
      ];
};

// What strapi::body (koa-body 6, through co-body) parses, and the limit it parses each up to.
const BODY_LIMITS = [
  {
    label: "an application/json body",
    option: "jsonLimit, 1mb",
    bytes: 1_048_576,
    parses: (type: string) =>
      type === "application/json" ||
      type === "application/json-patch+json" ||
      type === "application/vnd.api+json" ||
      type === "application/csp-report" ||
      type === "application/reports+json",
  },
  {
    label: "an application/x-www-form-urlencoded body",
    option: "formLimit, 56kb",
    bytes: 57_344,
    parses: (type: string) => type === "application/x-www-form-urlencoded",
  },
  {
    label: "a text/* body",
    option: "textLimit, 56kb",
    bytes: 57_344,
    parses: (type: string) => type.startsWith("text/"),
  },
] as const;

/**
 * An endpoint allowing a larger body than strapi::body parses for a media type it accepts: Strapi
 * refuses such a body with 413 before the guards' limit matters. Every type when it lists none.
 */
export const endpointGuardGaps = (doc: IrDocument): CapabilityGap[] =>
  guardedEndpoints(doc).flatMap((e): CapabilityGap[] => {
    const max = e.maxBodyBytes;
    if (max === undefined) return [];
    const types = e.accepts?.map((t) => t.toLowerCase());
    const refusing = BODY_LIMITS.flatMap((limit) => {
      if (limit.bytes >= max) return [];
      const named = types === undefined ? [] : types.filter(limit.parses);
      if (types !== undefined && named.length === 0) return [];
      const label =
        named.length === 1 && limit.label === "a text/* body" ? `a ${named[0]!} body` : limit.label;
      return [`${label} over ${limit.bytes} bytes (its ${limit.option})`];
    });
    if (refusing.length === 0) return [];
    return [
      {
        feature: "endpointBodyLimit",
        location: { contentType: e.contentType, rule: e.name },
        severity: "downgrade",
        message: `endpoint "${e.name}" allows a body of ${max} bytes, but strapi::body refuses ${refusing.join(" and ")} with 413 first, as camis generates config/middlewares with strapi::body's defaults`,
      },
    ];
  });
