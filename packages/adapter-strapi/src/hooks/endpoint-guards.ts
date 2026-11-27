import {
  endpointGuardsTable,
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

// How both middlewares tell a connection a refusal is closing, the same in every project.
const CLOSING = `
// The connections a refusal is closing. A request read from one after the refusal (pipelined
// behind it) must not be processed (RFC 9112 §9.6), so the first of the two middlewares drops it.
// Each middleware is a module of its own, so they share one set under a registry symbol.
const CLOSING: unique symbol = Symbol.for("camis.endpointGuards.closing");
const registry = globalThis as { [CLOSING]?: WeakSet<object> };
const closing = (registry[CLOSING] ??= new WeakSet<object>());

/**
 * Drops a request read after a refusal on its connection, before anything else of camis's runs:
 * unanswered, Koa told not to answer (the answer could only queue behind the side already shut),
 * and nothing destroyed, which would reset the connection under the refusal. The refusal's
 * lingering close ends the connection, and the request with it. Only strapi::logger,
 * strapi::errors and strapi::security run before it (and strapi::cors, when no endpoint answers
 * other origins): none processes a request, and an answer one writes is never sent.
 */
const dropped = (ctx: Context): boolean => {
  if (!closing.has(ctx.req.socket)) return false;
  ctx.respond = false;
  return true;
};
`;

// The cross-origin middleware's code, the same in every project; only CROSS_ORIGIN above it differs.
const CORS_RUNTIME = `
const MAX_AGE = "7200";
// A preflight's answer differs by the method and headers asked (never by origin, which every answer
// allows), so a cache keeps one per request.
const VARY = "Access-Control-Request-Method, Access-Control-Request-Headers";
${MATCHING}${CLOSING}
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
    if (dropped(ctx)) return;
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
/** How many callers each endpoint's throttle tracks at most, unless the deployment sets its own. */
const MAX_TRACKED_CALLERS = 100_000;
const MAX_TRACKED_CALLERS_ENV = "CAMIS_ENDPOINT_MAX_TRACKED_CALLERS";
/** How long a refused request's connection is kept, and how much of its body is drained meanwhile. */
const LINGER_MS = 2_000;
const LINGER_BYTES = 1_048_576;

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
${MATCHING}${CLOSING}
// A deployment's own number, read as the Filament target reads a rate: a whole number in ASCII
// digits, never less than one; any other value (empty, signed, 1e3, words) keeps the default, and
// so does one too large to count exactly, which would otherwise read as Infinity: no limit at all.
const fromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.max(1, value) : fallback;
};

const rate = (throttle: Throttle): number => fromEnv(throttle.env, throttle.perMinute);

const mediaType = (header: string): string => (header.split(";")[0] ?? "").trim().toLowerCase();

const hasBody = (ctx: Context): boolean => {
  const length = ctx.get("Content-Length");
  return (length !== "" && length !== "0") || ctx.get("Transfer-Encoding") !== "";
};

/**
 * A lingering close, as nginx does it, for a refusal that leaves the body unread. Node closes a
 * Connection: close socket as soon as the answer is written (destroySoon); with request bytes still
 * unread the kernel then resets the connection, and a reset can drop the answer before the client
 * reads it. So this reads and discards the body still coming from the refusal on, counting it as
 * it comes (read here, so Node does not discard it uncounted once the answer is sent), and stops
 * reading once past LINGER_BYTES (by at most the piece that takes it past) rather than drop the
 * connection: on a fast link that many bytes come within a millisecond, and a reset then can still
 * beat the answer to a client busy sending. A client that reads nothing until its whole body is
 * sent can therefore lose the answer when more than about LINGER_BYTES of the body is still to come
 * once it is refused. Once the answer is sent it takes Node's close back and shuts only the sending
 * side (the client reads the answer, then the end), and drops the connection when the client ends
 * or LINGER_MS have passed. The connection is marked closing at once, so a request pipelined behind
 * this one is dropped however soon Node reads it.
 */
const linger = (ctx: Context): void => {
  ctx.set("Connection", "close");
  const req = ctx.req;
  const socket = req.socket;
  closing.add(socket);
  let drained = 0;
  const count = (chunk: Buffer): void => {
    drained += chunk.length;
    if (drained <= LINGER_BYTES) return;
    req.off("data", count);
    req.pause();
  };
  req.on("data", count);
  req.resume();
  ctx.res.once("finish", () => {
    socket.removeListener("finish", socket.destroy);
    const stop = (): void => {
      clearTimeout(timer);
      req.off("data", count);
      socket.off("end", drop);
    };
    const drop = (): void => {
      stop();
      socket.destroy();
    };
    const timer = setTimeout(drop, LINGER_MS);
    timer.unref();
    socket.once("end", drop);
    socket.once("close", stop);
    if (socket.writable) socket.end();
  });
};

/** A refusal in Strapi's error body, as strapi::errors writes it. */
const refuse = (ctx: Context, refusal: Refusal): void => {
  ctx.status = refusal.status;
  ctx.body = {
    data: null,
    error: { status: refusal.status, name: refusal.name, message: refusal.message, details: {} },
  };
  if (hasBody(ctx)) linger(ctx);
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
        // Refused from here on: marked now, as Node may read a request pipelined behind this one
        // before the refusal is written.
        closing.add(req.socket);
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
 * One endpoint's throttle. Strapi's own throttles (users-permissions' koa2-ratelimit) count in the
 * process's memory, and so does this: with more than one Strapi process each counts apart. A
 * caller's count lives in the fixed window it began in, by the monotonic clock (a step of the wall
 * clock changes nothing); at a window's turn the one before it is dropped whole, every count in it
 * having expired, so forgetting costs nothing per request. At most \`cap\` callers are tracked
 * (about 205 bytes each, so about 20 MB at the default cap). A count stops taking room once it has
 * expired: each map holds its counts in the order they began, which is the order they expire (a
 * count in \`current\` never expires before the turn, so none is ever replaced there), so when the
 * cap is full the oldest count, first in \`previous\`, is dropped if it has expired, and the caller
 * takes its room. The cap thus binds only on callers active within the last window. While it does,
 * every caller not tracked shares one count, limited to the endpoint's rate a window. So memory
 * stays bounded, the callers not tracked together make no more than the rate, and a caller already
 * tracked keeps its own count until it expires; each endpoint has its own counter, so a flood on
 * one leaves the others alone. The residual: whoever keeps \`cap\` distinct callers (an IPv6 caller
 * by its /64) active every window keeps the cap full, and every caller not already tracked then
 * shares the endpoint's rate in total.
 */
const counter = (cap: number) => {
  let current = new Map<string, Count>();
  let previous = new Map<string, Count>();
  let turnAt = -Infinity;
  let shared: Count = { hits: 0, resetAt: -Infinity };
  const fresh = (now: number): Count => ({ hits: 0, resetAt: now + MINUTE });
  const seconds = (at: number, now: number): number => Math.max(1, Math.ceil((at - now) / 1000));
  const full = (): boolean => current.size + previous.size >= cap;
  const dropOldestIfExpired = (now: number): void => {
    const oldest = previous.keys().next();
    if (oldest.done === true) return;
    if ((previous.get(oldest.value)?.resetAt ?? now) <= now) previous.delete(oldest.value);
  };
  return (key: string, max: number): number | null => {
    const now = performance.now();
    if (now >= turnAt) {
      previous = now >= turnAt + MINUTE ? new Map() : current;
      current = new Map();
      turnAt = now + MINUTE;
    }
    let count = current.get(key) ?? previous.get(key);
    if (count === undefined || count.resetAt <= now) {
      if (full()) dropOldestIfExpired(now);
      if (full()) {
        if (shared.resetAt <= now) shared = fresh(now);
        count = shared;
      } else {
        count = fresh(now);
        current.set(key, count);
      }
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
export default (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  const prefix = String(strapi.config.get("api.rest.prefix", "/api"));
  const keys: unknown = strapi.config.get("server.app.keys", []);
  const secret = Array.isArray(keys) ? keys.map(String).join(",") : "";
  if (secret === "") throw new Error("server.app.keys (APP_KEYS) is empty, and the endpoint throttle keys its counter with it");
  const cap = fromEnv(MAX_TRACKED_CALLERS_ENV, MAX_TRACKED_CALLERS);
  const routes = GUARDS.map((guard) => ({
    guard,
    pattern: matcher(prefix, guard.path),
    methods: methods(guard.method),
    take: counter(cap),
  }));
  const keyed = (address: string): string =>
    createHmac("sha256", secret).update(caller(address)).digest("hex").slice(0, 32);

  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    if (dropped(ctx)) return;
    const route = routes.find((r) => r.methods.includes(ctx.method) && r.pattern.test(ctx.path));
    if (route === undefined) return next();
    const { guard, take } = route;

    if (guard.throttle !== undefined) {
      const wait = take(keyed(String(ctx.request.ip)), rate(guard.throttle));
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
  req: { socket: object };
  status: number;
  respond?: boolean;
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
  respond?: boolean;
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

// Where Strapi serves the content API: config/api.ts as camis writes it sets no rest.prefix.
const REST_PREFIX = "/api";

/** What an operator deploying the project needs to know of its guarded endpoints. */
const deploy = (guarded: Endpoint[]): string => `<!-- @camis:generated — do not edit -->
# Deploying this camis-generated Strapi project

## Endpoint guards

These endpoints' declared guards are checked by two global middlewares in
\`config/middlewares.ts\`: \`global::${ENDPOINT_CORS_MIDDLEWARE}\` (ahead of \`strapi::cors\`)
answers browsers on any origin for an endpoint with cross-origin request headers, without
credentials, and \`global::${ENDPOINT_GUARDS_MIDDLEWARE}\` (after \`strapi::cors\`, ahead of
\`strapi::body\`) refuses, in this order, a caller over the throttle (429 \`RateLimitError\` with
\`Retry-After\`, refused requests counted too), a body of a media type not listed (415
\`UnsupportedMediaTypeError\`) and a body larger than the limit, declared or sent (413
\`PayloadTooLargeError\`). Both run before Strapi authenticates the caller and asks its role, on
every endpoint; a public endpoint asks neither, so its handler is its only authorization.

${endpointGuardsTable(guarded, REST_PREFIX)}

A throttle's variable overrides its rate when it is a whole number in ASCII digits no larger than
9007199254740991, floored at 1; any other value keeps the declared rate. Each endpoint counts per caller address, an IPv6 caller by
its /64 (the block one subscriber is given), keyed by an HMAC of the address under \`APP_KEYS\`
(\`server.app.keys\`), so no address is kept; the middleware does not start without them, and
changing \`APP_KEYS\` starts every count afresh. Grouping IPv6 by /64 puts callers who share one in
a single count: those behind one NAT64, Teredo clients of one relay, every host of a shared /64. The
windows are fixed minutes, so a caller can make up to twice its rate across the turn of a window.

The counts are kept in the process's memory, as users-permissions' own throttle keeps them by
default: each Strapi process counts apart, so behind several processes a caller gets the rate from
each, and a restart forgets every count. Each endpoint tracks at most
\`CAMIS_ENDPOINT_MAX_TRACKED_CALLERS\` callers (read as a throttle's variable is; 100000 by
default), about 205 bytes each: about 20 MB of memory per throttled endpoint at the
default. A caller's count stops taking room once it has expired, so the cap binds only on callers
active within the last minute. While that many are tracked, every caller not tracked shares one
count for the endpoint, limited to the endpoint's rate a window, and a new caller, or one whose own
count has expired, is tracked again as soon as the oldest count expires and makes room. So memory
stays bounded, all the callers not tracked together make no more than the endpoint's rate, a flood
of addresses on one endpoint leaves every other endpoint's counts as they were, and a caller
already tracked keeps its own count until it expires. What remains: an attacker who keeps the cap's
worth of distinct callers active every minute (an IPv6 caller counted by its /64) holds it full,
and every caller not already tracked then shares the endpoint's rate in total. Against that, put a
limit at the reverse proxy or the network, or raise \`CAMIS_ENDPOINT_MAX_TRACKED_CALLERS\`, at
about 205 bytes a caller.

The caller address is Koa's \`ctx.request.ip\`. With \`server.proxy\` off it is the address the
connection comes from, so behind a reverse proxy every caller shares the proxy's address and one
count. With \`server.proxy\` on it is taken from \`X-Forwarded-For\`, which a client writes unless
the proxy in front replaces it, so the throttle is only as good as that proxy's configuration.

A refused request that still has a body coming is answered with \`Connection: close\`; the
connection is then shut on the server's side, about 1 MiB more of its body is read and discarded,
and the connection is dropped when the client ends it or at most 2 seconds after the answer, so the
client reads the answer before the connection is dropped. A client that reads nothing until its
whole body is sent can lose the refusal when more than about 1 MiB of its body is still to come once
it is refused, as behind nginx: for a 429, a 415 or a 413 by \`Content-Length\` that is the whole
body, whatever the limit. A request sent after the refused one on the same connection is not processed, while the
middlewares listed ahead of the camis ones keep requests in order (those \`config/middlewares.ts\`
lists as generated do): it is dropped unanswered, before any camis middleware or route runs.
`;

/** The global middlewares, and DEPLOY.md, a project's guarded endpoints need; none without. */
export const emitEndpointGuardFiles = (doc: IrDocument): GeneratedFile[] => {
  const guarded = guardedEndpoints(doc);
  const crossOrigin = guarded.filter(answersOtherOrigins);
  const checks = guarded.filter(checked);
  if (guarded.length === 0) return [];
  return [
    { path: "DEPLOY.md", content: deploy(guarded) },
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
