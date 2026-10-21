#!/usr/bin/env node
// Runs the Strapi users-permissions vectors against a running app on an empty database: each step
// is a request (in order) checked against the expected response, recorded from strapi-php
// (`--record`), which is how it is known to be Strapi's behaviour rather than camis's.
//
// Request bodies are sent as they are (the auth routes take no `{ data }` envelope). A step's
// `as` names the session to send, and `save` keeps the response's `jwt` under a name. A step with
// `hook` runs the runtime's hook command instead (`--hook`, given the step's words), which reads
// what only the database knows (a reset code) or changes what only an administrator can (the
// advanced settings, blocking a user); `into` keeps its output as `$name` for later steps, and
// `keep` keeps response values the same way (`{ "bobId": "user.id" }`). `bearer` sends a given
// token (a literal one that does not verify, or an API token a hook made), `headers` adds request
// headers, and `cookie` names a response cookie to record (set or cleared) and keep as `$<name>`.
// `jar` names a cookie jar the step sends and fills, as a browser would across an OAuth round
// trip, and `keepQuery` keeps query values of the redirect's location (`{ "state": "state" }`). A
// redirect's own origin and an OAuth state are masked, as they differ between runtimes and runs.
//
// usage: strapi-auth-vectors.mjs <api-base> --hook CMD [--vectors F] [--expected F] [--record]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../src/strapi-api/__fixtures__");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    hook: { type: "string" },
    vectors: { type: "string", default: join(fixtures, "auth-vectors.json") },
    expected: { type: "string", default: join(fixtures, "auth-vectors.expected.json") },
    record: { type: "boolean", default: false },
  },
});
const base = positionals[0];
if (base === undefined || values.hook === undefined) {
  console.error("usage: strapi-auth-vectors.mjs <api-base> --hook CMD [--record]");
  process.exit(2);
}
const { steps } = JSON.parse(readFileSync(values.vectors, "utf8"));

const sessions = new Map();
const vars = new Map();
const jars = new Map();
const VAR = /\$([a-zA-Z_]+)/g;
const fill = (value) => {
  if (typeof value === "string")
    return value.replace(VAR, (whole, name) => (vars.has(name) ? vars.get(name) : whole));
  if (Array.isArray(value)) return value.map(fill);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  return value;
};

const runHook = (words) => {
  const [command, ...args] = values.hook.split(" ");
  return execFileSync(command, [...args, ...fill(words)], { encoding: "utf8" }).trim();
};

const call = async (step) => {
  const headers = { Accept: "application/json", ...fill(step.headers ?? {}) };
  if (step.bearer !== undefined) headers.Authorization = `Bearer ${fill(step.bearer)}`;
  if (step.as !== undefined) {
    // A session an earlier step failed to open is sent as no session, so that step shows the cause.
    const jwt = sessions.get(step.as);
    if (jwt !== undefined) headers.Authorization = `Bearer ${jwt}`;
  }
  const jar = step.jar === undefined ? undefined : (jars.get(step.jar) ?? new Map());
  if (jar !== undefined && jar.size > 0)
    headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const init = { method: step.method ?? "POST", headers, redirect: "manual" };
  if (step.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(fill(step.body));
  }
  const response = await fetch(`${base}${fill(step.path)}`, init);
  if (jar !== undefined) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const [name, ...value] = pair.split("=");
      const expired = attributes.some((a) => /^\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(a));
      if (expired) jar.delete(name.trim());
      else jar.set(name.trim(), value.join("="));
    }
    jars.set(step.jar, jar);
  }
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // a redirect or an empty body
  }
  return {
    status: response.status,
    location: response.headers.get("location"),
    cookies: cookiesOf(response),
    body,
  };
};

// The response's cookies by name; an expired or emptied one is a cleared cookie.
const cookiesOf = (response) =>
  new Map(
    response.headers.getSetCookie().map((line) => {
      const [pair, ...attributes] = line.split(";");
      const [name, ...value] = pair.split("=");
      const expired = attributes.some((a) => /^\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(a));
      return [name.trim(), expired ? "" : decodeURIComponent(value.join("="))];
    }),
  );

// Server-assigned keys differ between runs and runtimes; tokens, session times and generated
// device ids are compared by presence.
const VOLATILE = new Set(["id", "documentId", "createdAt", "updatedAt", "publishedAt"]);
const PRESENCE = {
  jwt: "<jwt>",
  refreshToken: "<token>",
  loginAt: "<date>",
  lastActiveAt: "<date>",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const masked = (key, value) => {
  if (typeof value !== "string") return normalize(value);
  if (key in PRESENCE) return PRESENCE[key];
  return key === "deviceId" && UUID.test(value) ? "<uuid>" : value;
};
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !VOLATILE.has(k))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, masked(k, v)]),
    );
  return value;
};
const origin = new URL(base).origin;
const maskLocation = (location) =>
  location
    .replaceAll(origin, "<origin>")
    .replaceAll(encodeURIComponent(origin), "<origin>")
    .replace(/([?&]state=)[0-9a-f]{40}\b/, "$1<state>");
const outcome = ({ status, location, body }, cookie) => {
  if (status >= 300 && status < 400)
    return { status, location: maskLocation(fill(location ?? "")) };
  if (cookie !== undefined) return { ...outcome({ status, body }), cookie };
  if (body?.error) {
    const { name, message, details } = body.error;
    // PHP encodes an empty details object as [], strapi-php included.
    const empty = details === undefined || (Array.isArray(details) && details.length === 0);
    return { status, error: { name, message, details: empty ? {} : details } };
  }
  return { status, body: normalize(body) };
};

const outcomes = [];
for (const step of steps) {
  if (step.hook !== undefined) {
    const out = runHook(step.hook);
    if (step.into !== undefined) vars.set(step.into, out);
    continue;
  }
  const response = await call(step);
  if (step.save !== undefined && typeof response.body?.jwt === "string")
    sessions.set(step.save, response.body.jwt);
  for (const [name, path] of Object.entries(step.keep ?? {}))
    vars.set(name, String(path.split(".").reduce((value, key) => value?.[key], response.body)));
  for (const [name, param] of Object.entries(step.keepQuery ?? {}))
    vars.set(name, new URL(response.location ?? "", base).searchParams.get(param) ?? "");
  let cookie;
  if (step.cookie !== undefined) {
    const value = response.cookies.get(step.cookie);
    cookie = value === undefined ? "<none>" : value === "" ? "<cleared>" : "<set>";
    if (value) vars.set(step.cookie, value);
  }
  outcomes.push({ name: step.name, ...outcome(response, cookie) });
}

if (values.record) {
  writeFileSync(values.expected, `${JSON.stringify(outcomes, null, 2)}\n`);
  console.log(`recorded ${outcomes.length} outcomes`);
  process.exit(0);
}
const expected = JSON.parse(readFileSync(values.expected, "utf8"));
let failed = 0;
expected.forEach((want, i) => {
  const got = outcomes[i];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed += 1;
    console.error(
      `FAIL ${want.name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`,
    );
  }
});
if (failed > 0 || outcomes.length !== expected.length) {
  console.error(`${failed} of ${expected.length} auth vectors failed`);
  process.exit(1);
}
console.log(`AUTH VECTORS OK (${expected.length} checks)`);
