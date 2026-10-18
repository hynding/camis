#!/usr/bin/env node
// Runs the Strapi populate and relation vectors against a running app on an empty database: seeds
// the rows, then checks every read and write (in order) against the expected responses. The
// expected file is recorded from strapi-php (`--record`), which is how it is known to be Strapi's
// behaviour rather than camis's.
//
// usage: strapi-populate-vectors.mjs <api-base> [--token T] [--vectors F] [--expected F] [--record]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../src/strapi-api/__fixtures__");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    token: { type: "string" },
    vectors: { type: "string", default: join(fixtures, "populate-vectors.json") },
    expected: { type: "string", default: join(fixtures, "populate-vectors.expected.json") },
    record: { type: "boolean", default: false },
  },
});
const base = positionals[0];
if (base === undefined) {
  console.error("usage: strapi-populate-vectors.mjs <api-base> [--token T] [--record]");
  process.exit(2);
}
const vectors = JSON.parse(readFileSync(values.vectors, "utf8"));

const refs = new Map(); // "authors:Ann" → { id, documentId }
const ref = (token) => {
  const found = refs.get(token.slice(1));
  if (found === undefined) throw new Error(`unknown reference ${token}`);
  return token.startsWith("@") ? found.documentId : found.id;
};
const REF = /^[@#][a-z]+:[A-Za-z]+$/;
const resolve = (value) => {
  if (typeof value === "string" && REF.test(value)) return ref(value);
  if (Array.isArray(value)) return value.map(resolve);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  return value;
};
const resolveText = (text) => text.replace(/[@#][a-z]+:[A-Za-z]+/g, (t) => String(ref(t)));

const call = async (method, path, query, data) => {
  const url = `${base}${resolveText(path)}${query ? `?${resolveText(query)}` : ""}`;
  const headers = { Accept: "application/json" };
  if (values.token) headers.Authorization = `Bearer ${values.token}`;
  const init = { method, headers };
  if (data !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({ data: resolve(data) });
  }
  const response = await fetch(url, init);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
};

// Server-assigned keys differ between runs and runtimes; nulls are dropped because camis leaves
// null scalars off the wire (a known gap, PLAN.md Phase 19). publishedAt is dropped too unless the
// vector file asks for its presence: Strapi stamps it even on types without draft and publish.
const publishedAtPresence = vectors.publishedAt === "presence";
const VOLATILE = new Set(["id", "documentId", "createdAt", "updatedAt"]);
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k, v]) => !VOLATILE.has(k) && (k === "publishedAt" ? publishedAtPresence : v !== null),
        )
        .map(([k, v]) => (k === "publishedAt" ? [k, v === null ? "absent" : "present"] : [k, v]))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  return value;
};
// An error compares by status, name and message; details only when they are about the query or
// body key (the relation-not-found details echo the whole payload with server timestamps).
const outcome = ({ status, body }) => {
  if (body?.error) {
    const { name, message, details } = body.error;
    const keyed = details && typeof details === "object" && "key" in details;
    return { status, error: { name, message, ...(keyed ? { details } : {}) } };
  }
  return { status, data: normalize(body?.data ?? null) };
};

for (const row of vectors.seed) {
  const { status, body } = await call("POST", row.path, row.query ?? "", row.data);
  if (status !== 200 && status !== 201) {
    console.error(`SEED FAIL ${row.as} (${status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  refs.set(row.as, { id: body.data.id, documentId: body.data.documentId });
}

const results = {};
for (const v of vectors.reads) results[v.name] = outcome(await call("GET", v.path, v.query));
for (const v of vectors.writes) {
  const response = await call(v.method, v.path, v.query ?? vectors.defaultQuery, v.data);
  if (v.as !== undefined && response.body?.data)
    refs.set(v.as, { id: response.body.data.id, documentId: response.body.data.documentId });
  results[v.name] = outcome(response);
}

if (values.record) {
  writeFileSync(values.expected, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`recorded ${Object.keys(results).length} outcomes to ${values.expected}`);
  process.exit(0);
}

const expected = JSON.parse(readFileSync(values.expected, "utf8"));
let failures = 0;
for (const [name, want] of Object.entries(expected)) {
  const got = results[name];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures += 1;
    console.error(`FAIL ${name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
}
const total = Object.keys(expected).length;
if (failures > 0) {
  console.error(`POPULATE VECTORS: ${failures} of ${total} failed`);
  process.exit(1);
}
console.log(`POPULATE VECTORS OK (${total} checks)`);
