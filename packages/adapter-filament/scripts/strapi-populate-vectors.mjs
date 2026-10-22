#!/usr/bin/env node
// Runs the Strapi populate and relation vectors against a running app on an empty database: seeds
// the rows, then checks every read and write (in order) against the expected responses. The
// expected file is recorded from strapi-php (`--record`), which is how it is known to be Strapi's
// behaviour rather than camis's.
//
// A step with `upload` posts multipart form data instead: each entry names a file under
// __fixtures__/media and the fileInfo sent with it, and `form` adds fields (ref, refId, field).
// A step with `graphql` posts that query and its `variables` to the GraphQL endpoint (`--graphql`,
// else /graphql beside the API base); a mutation's `as` names the document its first field returns.
// A step with only `wait` pauses that many milliseconds, so a later write lands in a later second.
// A file's `compare` lists server-assigned keys to compare after all (`documentId`).
//
// usage: strapi-populate-vectors.mjs <api-base> [--token T] [--vectors F] [--expected F] [--graphql URL] [--record]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
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
    graphql: { type: "string" },
  },
});
const base = positionals[0];
if (base === undefined) {
  console.error("usage: strapi-populate-vectors.mjs <api-base> [--token T] [--record]");
  process.exit(2);
}
const vectors = JSON.parse(readFileSync(values.vectors, "utf8"));
const graphqlEndpoint = values.graphql ?? base.replace(/\/api\/?$/, "/graphql");

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

const multipart = (upload, form) => {
  const body = new FormData();
  for (const { file, info } of upload) {
    body.append("files", new Blob([readFileSync(join(fixtures, "media", file))]), file);
    if (info !== undefined) body.append("fileInfo", JSON.stringify(info));
  }
  for (const [key, value] of Object.entries(form ?? {})) body.append(key, resolveText(value));
  return body;
};

const call = async (method, path, query, data, upload, form) => {
  const url = `${base}${resolveText(path)}${query ? `?${resolveText(query)}` : ""}`;
  const headers = { Accept: "application/json" };
  if (values.token) headers.Authorization = `Bearer ${values.token}`;
  const init = { method, headers };
  if (upload !== undefined) {
    init.body = multipart(upload, form);
  } else if (data !== undefined) {
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

const graphql = async (query, variables) => {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (values.token) headers.Authorization = `Bearer ${values.token}`;
  const response = await fetch(graphqlEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: resolveText(query),
      ...(variables ? { variables: resolve(variables) } : {}),
    }),
  });
  return { status: response.status, body: await response.json() };
};

// Server-assigned keys differ between runs and runtimes; nulls are dropped because camis leaves
// null scalars off the wire (a known gap, PLAN.md Phase 19). publishedAt is dropped too unless the
// vector file asks for its presence: Strapi stamps it even on types without draft and publish.
const publishedAtPresence = vectors.publishedAt === "presence";
// A stored file's hash (and so its url) ends in random hex, and an image's byte size depends on
// the encoder that resized it (sharp, GD), so neither is compared.
// A vector file's `compare` keeps some of them: an import keeps every documentId.
const VOLATILE = new Set(
  ["id", "documentId", "createdAt", "updatedAt"].filter(
    (k) => !(vectors.compare ?? []).includes(k),
  ),
);
const RANDOM_SUFFIX = /_[0-9a-f]{10}(?=\.|$)/g;
const encoded = (file, key) =>
  (key === "size" || key === "sizeInBytes") &&
  typeof file.width === "number" &&
  String(file.mime).startsWith("image/");
const normalize = (value, keepNulls = false) => {
  if (Array.isArray(value)) return value.map((v) => normalize(v, keepNulls));
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k, v]) =>
            !VOLATILE.has(k) &&
            !encoded(value, k) &&
            (k === "publishedAt" ? publishedAtPresence : keepNulls || v !== null),
        )
        .map(([k, v]) =>
          (k === "hash" || k === "url") && typeof v === "string"
            ? [k, v.replace(RANDOM_SUFFIX, "_<hash>")]
            : [k, v],
        )
        .map(([k, v]) => (k === "publishedAt" ? [k, v === null ? "absent" : "present"] : [k, v]))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v, keepNulls)]),
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
  // Plugin routes (the i18n locales list, the upload API) answer with a bare array or object.
  return { status, data: normalize(bare(body) ? body : (body?.data ?? null)) };
};

// A GraphQL answer keeps its nulls (the schema sends every field asked for); an error compares by
// message, code, path and Strapi's error, never by the stack trace a development server adds.
const graphqlOutcome = ({ body }) => ({
  data: normalize(body.data ?? null, true),
  errors: (body.errors ?? []).map((e) => {
    const error = e.extensions?.error;
    const keyed = error?.details && typeof error.details === "object" && "key" in error.details;
    return {
      message: e.message,
      code: e.extensions?.code ?? null,
      path: e.path ?? null,
      ...(error
        ? {
            error: {
              name: error.name,
              message: error.message,
              ...(keyed ? { details: error.details } : {}),
            },
          }
        : {}),
    };
  }),
});

function bare(body) {
  return Array.isArray(body) || (body !== null && typeof body === "object" && !("data" in body));
}
// What `as` names: the first file of an upload, or the document written.
const written = (body) => (Array.isArray(body) ? body[0] : bare(body) ? body : body?.data);

for (const row of vectors.seed) {
  const { status, body } = await call(row.method ?? "POST", row.path, row.query ?? "", row.data);
  if (status !== 200 && status !== 201) {
    console.error(`SEED FAIL ${row.as} (${status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  refs.set(row.as, { id: body.data.id, documentId: body.data.documentId });
}

const results = {};
for (const v of vectors.reads)
  results[v.name] =
    v.graphql !== undefined
      ? graphqlOutcome(await graphql(v.graphql, v.variables))
      : outcome(await call("GET", v.path, v.query));
for (const v of vectors.writes) {
  if (v.wait !== undefined) {
    await pause(v.wait);
    continue;
  }
  if (v.graphql !== undefined) {
    const response = await graphql(v.graphql, v.variables);
    const target = Object.values(response.body.data ?? {})[0];
    if (v.as !== undefined && target?.documentId !== undefined)
      refs.set(v.as, { id: null, documentId: target.documentId });
    results[v.name] = graphqlOutcome(response);
    continue;
  }
  const response = await call(
    v.method ?? "POST",
    v.path,
    v.query ?? vectors.defaultQuery,
    v.data,
    v.upload,
    v.form,
  );
  const target = written(response.body);
  if (v.as !== undefined && target?.id !== undefined)
    refs.set(v.as, { id: target.id, documentId: target.documentId });
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
