import {
  endpointThrottleEnv,
  isGuardedEndpoint,
  withMarker,
  type GeneratedFile,
} from "@camis/adapter-kernel";
import type { CapabilityGap, Endpoint, IrDocument } from "@camis/ir-schema";

/**
 * The global middlewares' names: an underscore, which no IR route middleware's file name (a kebab
 * slug of a PascalCase name) has, so they never meet one in src/middlewares.
 */
export const ENDPOINT_CORS_MIDDLEWARE = "camis_endpoint_cors";
export const ENDPOINT_GUARDS_MIDDLEWARE = "camis_endpoint_guards";

const guardedEndpoints = (doc: IrDocument): Endpoint[] =>
  (doc.endpoints ?? []).filter(isGuardedEndpoint).sort((a, b) => a.name.localeCompare(b.name));

/** Whether the endpoint has a guard the guards' middleware checks (all but crossOrigin). */
const checked = (e: Endpoint): boolean =>
  e.throttle !== undefined || e.maxBodyBytes !== undefined || e.accepts !== undefined;

const answersOtherOrigins = (e: Endpoint): boolean => e.crossOrigin !== undefined;

/** The global middlewares the project's guarded endpoints need, by their place around strapi::cors. */
export interface EndpointGuardMiddlewares {
  /** Ahead of strapi::cors: the endpoints answering browsers on any origin. */
  cors?: string;
  /** After strapi::cors and ahead of strapi::body: the checks. */
  guards?: string;
}

export const endpointGuardMiddlewares = (doc: IrDocument): EndpointGuardMiddlewares => {
  const guarded = guardedEndpoints(doc);
  return {
    ...(guarded.some(answersOtherOrigins) ? { cors: ENDPOINT_CORS_MIDDLEWARE } : {}),
    ...(guarded.some(checked) ? { guards: ENDPOINT_GUARDS_MIDDLEWARE } : {}),
  };
};

const json = (value: string): string => JSON.stringify(value);
const list = (items: string[]): string => `[${items.map(json).join(", ")}]`;
const entry = (keys: string[]): string => `  {\n${keys.map((k) => `    ${k},`).join("\n")}\n  },`;
const routeKeys = (e: Endpoint): string[] => [
  `name: ${json(e.name)}`,
  `method: ${json(e.method)}`,
  `path: ${json(e.path)}`,
];

const guardEntry = (e: Endpoint): string =>
  entry([
    ...routeKeys(e),
    ...(e.throttle === undefined
      ? []
      : [
          `throttle: { perMinute: ${e.throttle.perMinute}, env: ${json(endpointThrottleEnv(e.name))} }`,
        ]),
    ...(e.maxBodyBytes === undefined ? [] : [`maxBodyBytes: ${e.maxBodyBytes}`]),
    ...(e.accepts === undefined ? [] : [`accepts: ${list(e.accepts.map((t) => t.toLowerCase()))}`]),
  ]);

const crossOriginEntry = (e: Endpoint): string =>
  entry([...routeKeys(e), `headers: ${list(e.crossOrigin?.headers ?? [])}`]);

// How both middlewares find a route, the same in every project.
const MATCHING = `
const escape = (text: string): string => text.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");

// Strapi's router (@koa/router) matches a route case-insensitively, with or without a trailing
// slash, and a :param as one segment of the raw path; this matches it the same way, so no spelling
// of the path reaches the endpoint around it. A GET route answers HEAD too.
const matcher = (prefix: string, path: string): RegExp =>
  new RegExp(\`^\${escape(prefix + path).replace(/:[A-Za-z0-9_-]+/g, "[^/]+")}/?$\`, "i");

const methods = (method: string): string[] => (method === "GET" ? ["GET", "HEAD"] : [method]);
`;

// The cross-origin middleware's code, the same in every project; only CROSS_ORIGIN above it differs.
const CORS_RUNTIME = `
const MAX_AGE = "7200";
// A preflight's answer differs by the method and headers asked (never by origin, which every answer
// allows), so a cache keeps one per request.
const VARY = "Access-Control-Request-Method, Access-Control-Request-Headers";
${MATCHING}
const openToAnyOrigin = (ctx: Context): void => {
  ctx.set("Access-Control-Allow-Origin", "*");
  ctx.set("Access-Control-Expose-Headers", "Retry-After");
  ctx.remove("Access-Control-Allow-Credentials");
};

/**
 * The IR endpoints answering browsers on any origin, ahead of strapi::cors: a preflight asking for
 * the method of an endpoint on its path is answered with exactly that endpoint's request headers,
 * and every answer of such an endpoint, the guards' refusals and errors included, allows any origin
 * without credentials and exposes Retry-After. strapi::cors still runs for such an answer, and its
 * headers are replaced on the way out. Every other request is the app's CORS to answer.
 */
export default (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  const prefix = String(strapi.config.get("api.rest.prefix", "/api"));
  const routes = CROSS_ORIGIN.map((endpoint) => ({
    endpoint,
    pattern: matcher(prefix, endpoint.path),
    methods: methods(endpoint.method),
  }));

  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const onPath = routes.filter((route) => route.pattern.test(ctx.path));
    if (onPath.length === 0) return next();
    const asked = ctx.get("Access-Control-Request-Method").toUpperCase();
    if (ctx.method === "OPTIONS" && asked !== "") {
      const answered = onPath.find((route) => route.methods.includes(asked))?.endpoint;
      if (answered === undefined) return next();
      openToAnyOrigin(ctx);
      ctx.set("Access-Control-Allow-Methods", answered.method);
      if (answered.headers.length > 0) ctx.set("Access-Control-Allow-Headers", answered.headers.join(", "));
      ctx.set("Access-Control-Max-Age", MAX_AGE);
      ctx.set("Vary", VARY);
      ctx.status = 204;
      return;
    }
    if (!onPath.some((route) => route.methods.includes(ctx.method))) return next();
    openToAnyOrigin(ctx);
    try {
      await next();
    } finally {
      openToAnyOrigin(ctx);
    }
  };
};
`;

// The guards' middleware's code, the same in every project; only GUARDS above it differs.
const GUARDS_RUNTIME = `
const MINUTE = 60_000;
/** How many callers the throttle tracks at most, unless the middleware's config sets maxTrackedCallers. */
const MAX_TRACKED_CALLERS = 100_000;

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
${MATCHING}
// A deployment's own rate, read as the Filament target reads it: a whole number in ASCII digits,
// never less than one a minute; any other value (empty, signed, 1e3, words) keeps the IR's rate.
const rate = (throttle: Throttle): number => {
  const raw = process.env[throttle.env];
  return raw !== undefined && /^[0-9]+$/.test(raw) ? Math.max(1, Number(raw)) : throttle.perMinute;
};

const mediaType = (header: string): string => (header.split(";")[0] ?? "").trim().toLowerCase();

const hasBody = (ctx: Context): boolean => {
  const length = ctx.get("Content-Length");
  return (length !== "" && length !== "0") || ctx.get("Transfer-Encoding") !== "";
};

/**
 * A refusal in Strapi's error body, as strapi::errors writes it. It leaves the body unread, so the
 * connection is closed once the refusal is sent: Node would otherwise read and discard the rest, for
 * as long as the client goes on sending it.
 */
const refuse = (ctx: Context, refusal: Refusal): void => {
  ctx.status = refusal.status;
  ctx.body = {
    data: null,
    error: { status: refusal.status, name: refusal.name, message: refusal.message, details: {} },
  };
  if (hasBody(ctx)) {
    ctx.set("Connection", "close");
    const req = ctx.req;
    ctx.res.once("finish", () => req.destroy());
  }
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
 * The caller an address counts as: an IPv6 address by its /64, the block one subscriber is given,
 * so a caller cannot take a fresh address per request; an IPv4 address mapped into IPv6 as itself.
 */
const caller = (address: string): string => {
  const bare = address.split("%")[0] ?? "";
  if (isIP(bare) !== 6) return address;
  const dotted = /^(.*:)(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(bare);
  const pair = (high: string | undefined, low: string | undefined): string =>
    ((Number(high) << 8) | Number(low)).toString(16);
  const text = dotted === null ? bare : \`\${dotted[1]}\${pair(dotted[2], dotted[3])}:\${pair(dotted[4], dotted[5])}\`;
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined ? left : [...left, ...new Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const n = groups.map((group) => Number.parseInt(group, 16));
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = n;
  if ([g0, g1, g2, g3, g4].every((group) => group === 0) && g5 === 0xffff) {
    return [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255].join(".");
  }
  return \`\${n.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64\`;
};

interface Count {
  hits: number;
  resetAt: number;
}

/**
 * Strapi's own throttles (users-permissions' koa2-ratelimit) count in the process's memory, and so
 * does this: with more than one Strapi process each counts apart. A caller's count lives in the
 * window it began in; at a window's turn the one before it is dropped whole, every count in it
 * having expired, so forgetting costs nothing per request. At most \`cap\` callers are tracked: a new
 * caller beyond them is refused, as one over the throttle is, until a window is dropped, rather than
 * the counter growing without bound.
 */
const counter = (cap: number) => {
  let current = new Map<string, Count>();
  let previous = new Map<string, Count>();
  let turnAt = 0;
  const seconds = (at: number, now: number): number => Math.max(1, Math.ceil((at - now) / 1000));
  return (key: string, max: number): number | null => {
    const now = Date.now();
    if (now >= turnAt) {
      previous = now >= turnAt + MINUTE ? new Map() : current;
      current = new Map();
      turnAt = now + MINUTE;
    }
    let count = current.get(key) ?? previous.get(key);
    if (count === undefined || count.resetAt <= now) {
      if (current.size + previous.size >= cap) {
        return seconds(previous.size > 0 ? turnAt : turnAt + MINUTE, now);
      }
      count = { hits: 0, resetAt: now + MINUTE };
      current.set(key, count);
    }
    count.hits += 1;
    return count.hits > max ? seconds(count.resetAt, now) : null;
  };
};

/**
 * The IR endpoints' declared guards, after strapi::cors (so a refusal carries the app's CORS
 * headers, or an endpoint's own, which camis_endpoint_cors writes on the way out) and ahead of
 * strapi::body and the route, in this order: a caller over the throttle (refused requests count
 * too), a body of another media type (parameters ignored) and a body over its size (by its
 * Content-Length, or by the bytes read when it has none: Node reads no more than a declared length)
 * are refused, each in Strapi's error body. The throttle counts per caller, keyed by an HMAC of the
 * caller under the app's keys (server.app.keys), so no address is kept.
 */
export default (config: { maxTrackedCallers?: unknown } | undefined, { strapi }: { strapi: Core.Strapi }) => {
  const prefix = String(strapi.config.get("api.rest.prefix", "/api"));
  const keys: unknown = strapi.config.get("server.app.keys", []);
  const secret = Array.isArray(keys) ? keys.map(String).join(",") : "";
  if (secret === "") throw new Error("server.app.keys (APP_KEYS) is empty, and the endpoint throttle keys its counter with it");
  const tracked = config?.maxTrackedCallers;
  const cap = typeof tracked === "number" && Number.isInteger(tracked) && tracked > 0 ? tracked : MAX_TRACKED_CALLERS;
  const routes = GUARDS.map((guard) => ({ guard, pattern: matcher(prefix, guard.path), methods: methods(guard.method) }));
  const take = counter(cap);
  const keyed = (address: string): string =>
    createHmac("sha256", secret).update(caller(address)).digest("hex").slice(0, 32);

  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const guard = routes.find((route) => route.methods.includes(ctx.method) && route.pattern.test(ctx.path))?.guard;
    if (guard === undefined) return next();

    if (guard.throttle !== undefined) {
      const wait = take(\`\${guard.name}|\${keyed(String(ctx.request.ip))}\`, rate(guard.throttle));
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
    return next();
  };
};
`;

const ROUTE_TYPE = `interface Route {
  name: string;
  method: string;
  /** Under the content API's prefix, Strapi's form. */
  path: string;
}`;

const CORS_HEAD = `import type { Core } from "@strapi/strapi";

${ROUTE_TYPE}

interface CrossOrigin extends Route {
  /** The request headers its preflight allows. */
  headers: string[];
}

/** What the middleware reads of Koa's context. */
interface Context {
  method: string;
  path: string;
  status: number;
  get(field: string): string;
  set(field: string, value: string): void;
  remove(field: string): void;
}
`;

const GUARDS_HEAD = `import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { Core } from "@strapi/strapi";

${ROUTE_TYPE}

interface Throttle {
  perMinute: number;
  /** The variable a deployment overrides the rate with. */
  env: string;
}

interface Guard extends Route {
  throttle?: Throttle;
  maxBodyBytes?: number;
  accepts?: string[];
}

/** What the middleware reads of Koa's context. */
interface Context {
  method: string;
  path: string;
  req: IncomingMessage;
  res: { once(event: "finish", listener: () => void): unknown };
  request: { ip: string; req: IncomingMessage };
  status: number;
  body: unknown;
  get(field: string): string;
  set(field: string, value: string): void;
  remove(field: string): void;
}
`;

const corsMiddleware = (endpoints: Endpoint[]): string =>
  withMarker(`${CORS_HEAD}
// Each IR endpoint answering browsers on any origin.
const CROSS_ORIGIN: CrossOrigin[] = [
${endpoints.map(crossOriginEntry).join("\n")}
];
${CORS_RUNTIME}`);

const guardsMiddleware = (endpoints: Endpoint[]): string =>
  withMarker(`${GUARDS_HEAD}
// Each guarded IR endpoint's checked guards.
const GUARDS: Guard[] = [
${endpoints.map(guardEntry).join("\n")}
];
${GUARDS_RUNTIME}`);

/** The global middlewares a project's guarded endpoints need; none without. */
export const emitEndpointGuardFiles = (doc: IrDocument): GeneratedFile[] => {
  const guarded = guardedEndpoints(doc);
  const crossOrigin = guarded.filter(answersOtherOrigins);
  const checks = guarded.filter(checked);
  return [
    ...(crossOrigin.length === 0
      ? []
      : [
          {
            path: `src/middlewares/${ENDPOINT_CORS_MIDDLEWARE}.ts`,
            content: corsMiddleware(crossOrigin),
          },
        ]),
    ...(checks.length === 0
      ? []
      : [
          {
            path: `src/middlewares/${ENDPOINT_GUARDS_MIDDLEWARE}.ts`,
            content: guardsMiddleware(checks),
          },
        ]),
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
