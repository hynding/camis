#!/usr/bin/env node
// Runs the MCP vectors against a running app on an empty database: each step is an HTTP request
// to the MCP endpoint (or Strapi's admin API) checked against the response recorded from
// strapi-php (`--record`), which is how it is known to be Strapi's behaviour rather than camis's.
//
// A step's `rpc` is the JSON-RPC body POSTed to /mcp with the step's `token` (a name `admin`
// steps made) or `bearer`; `headers` replaces the MCP request headers, `method` and `raw` send
// something else. An `admin` step calls the admin API as the signed-in admin and `keep`s response
// values (`{ "key": "data.accessKey" }`) as `$name`s (`rows`: permission rows, as a token takes them). A `hook` step runs the runtime's hook
// command (`--hook`, given the step's words) on camis, and its `oracle` request on strapi-php,
// for what only the database or an admin-only route can change.
//
// An SSE answer is compared as its messages; a tool result's text, which is its structured
// content as JSON, as that. Document ids and times differ between runtimes and runs, so a
// document id compares by the order it first appeared in, and a time by being one.
//
// usage: strapi-mcp-vectors.mjs <origin> --hook CMD [--vectors F] [--expected F] [--record]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../src/strapi-api/__fixtures__/mcp");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    hook: { type: "string" },
    vectors: { type: "string", default: join(fixtures, "mcp-vectors.json") },
    expected: { type: "string", default: join(fixtures, "mcp-vectors.expected.json") },
    record: { type: "boolean", default: false },
  },
});
const origin = positionals[0]?.replace(/\/$/, "");
if (origin === undefined || (values.hook === undefined && !values.record)) {
  console.error("usage: strapi-mcp-vectors.mjs <origin> --hook CMD [--record]");
  process.exit(2);
}
const { admin, steps } = JSON.parse(readFileSync(values.vectors, "utf8"));

const vars = new Map();
const VAR = /\$([a-zA-Z_]+)/g;
const fill = (value) => {
  if (typeof value === "string" && /^\$[a-zA-Z_]+$/.test(value) && vars.has(value.slice(1)))
    return vars.get(value.slice(1));
  if (typeof value === "string")
    return value.replace(VAR, (whole, name) => (vars.has(name) ? vars.get(name) : whole));
  if (Array.isArray(value)) return value.map(fill);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  return value;
};
const dig = (value, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), value);

let jwt;
const signIn = async () => {
  const send = (path) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(admin),
    }).then((r) => r.json());
  const registered = await send("/admin/register-admin");
  jwt = registered?.data?.token ?? (await send("/admin/login"))?.data?.token;
  if (jwt === undefined) throw new Error("could not sign the admin in");
};

const adminCall = async ({ method = "GET", path, body }) => {
  const response = await fetch(`${origin}${fill(path)}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(fill(body)),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
};

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const mcpCall = async (step) => {
  const headers = { ...(step.headers ?? MCP_HEADERS) };
  const bearer = step.token !== undefined ? vars.get(step.token) : step.bearer;
  if (bearer !== undefined) headers.Authorization = `Bearer ${fill(bearer)}`;
  const method = step.method ?? "POST";
  const response = await fetch(`${origin}/mcp`, {
    method,
    headers,
    body: method === "GET" ? undefined : (step.raw ?? JSON.stringify(fill(step.rpc ?? null))),
  });
  const text = await response.text();
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  const outcome = { status: response.status, type: type === "" ? null : type };
  if (response.headers.get("allow") !== null) outcome.allow = response.headers.get("allow");
  if (type === "text/event-stream") {
    outcome.messages = text
      .split("\n\n")
      .filter((event) => event.trim() !== "")
      .map((event) => {
        const lines = event.split("\n");
        const data = lines.find((l) => l.startsWith("data: "));
        return {
          event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? null,
          data: data === undefined ? null : JSON.parse(data.slice(6)),
        };
      });
  } else if (type === "application/json") {
    outcome.body = JSON.parse(text);
  } else if (text !== "") {
    outcome.text = text;
  }
  return outcome;
};

// --- masking ----------------------------------------------------------------------------------

const documents = new Map();
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const documentId = (id) => {
  if (!documents.has(id)) documents.set(id, `<document ${documents.size + 1}>`);
  return documents.get(id);
};
// Row ids differ too (a runtime may keep a draft's row where another makes a new one), so a
// result's row id compares by being one.
const mask = (value, key, inResult = false) => {
  if (Array.isArray(value)) return value.map((v) => mask(v, key, inResult));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mask(v, k, inResult || k === "result")]),
    );
  if (inResult && key === "id" && typeof value === "number") return "<id>";
  if (typeof value === "string" && key === "documentId") return documentId(value);
  if (typeof value === "string" && TIME.test(value)) return "<time>";
  return value;
};

/** A tool result's text is its structured content as JSON: compared once, as that. */
const toolResult = (result) => {
  if (result === null || typeof result !== "object" || !Array.isArray(result.content))
    return result;
  const content = result.content.map((part) => {
    if (part.type !== "text") return part;
    try {
      const parsed = JSON.parse(part.text);
      return JSON.stringify(parsed) === JSON.stringify(result.structuredContent)
        ? { type: "text", text: "<structuredContent>" }
        : part;
    } catch {
      return part;
    }
  });
  return { ...result, content };
};

/** tools/list, answered in full by the unit tests, compares as its names and chosen inputs. */
const toolsList = (result, inputs) => ({
  names: result.tools.map((t) => t.name),
  inputs: Object.fromEntries(
    (inputs ?? []).map((path) => {
      const [name, ...rest] = path.split(".");
      const tool = result.tools.find((t) => t.name === name);
      return [path, tool === undefined ? null : (dig(tool.inputSchema, rest.join(".")) ?? null)];
    }),
  ),
});

const shape = (step, outcome) => {
  if (outcome.messages === undefined) return mask(outcome);
  const messages = outcome.messages.map(({ event, data }) => {
    if (data?.result?.tools !== undefined && step.list !== undefined)
      return { event, data: { ...data, result: toolsList(data.result, step.list) } };
    if (data?.result?.content !== undefined)
      return { event, data: { ...data, result: toolResult(data.result) } };
    return { event, data };
  });
  return mask({ ...outcome, messages });
};

// --- run --------------------------------------------------------------------------------------

const runHook = (words) => {
  const [command, ...args] = values.hook.split(" ");
  return execFileSync(command, [...args, ...fill(words)], { encoding: "utf8" }).trim();
};

// camis's first admin is made by the hook: its IR may name no admin role to register one into.
if (!values.record)
  runHook(["admin", admin.email, admin.password, admin.firstname, admin.lastname]);
await signIn();
const outcomes = [];
for (const step of steps) {
  if (step.hook !== undefined) {
    if (values.record) await adminCall(step.oracle);
    else runHook(step.hook);
    continue;
  }
  if (step.admin !== undefined) {
    const { status, body } = await adminCall(step.admin);
    for (const [name, path] of Object.entries(step.keep ?? {})) {
      const kept = dig(body, path);
      // Permission rows as an admin token takes them back: Strapi refuses their other keys.
      vars.set(
        name,
        step.rows === true
          ? kept.map(({ action, subject, properties, conditions }) => ({
              action,
              subject,
              properties,
              conditions,
            }))
          : kept,
      );
    }
    if (status >= 300) throw new Error(`admin step failed (${status}): ${JSON.stringify(body)}`);
    continue;
  }
  const raw = await mcpCall(step);
  const data = raw.messages?.[0]?.data;
  for (const [name, path] of Object.entries(step.keep ?? {})) vars.set(name, dig(data, path));
  outcomes.push({ step: step.name, ...shape(step, raw) });
}

if (values.record) {
  writeFileSync(values.expected, `${JSON.stringify(outcomes, null, 2)}\n`);
  console.log(`recorded ${outcomes.length} MCP vectors`);
  process.exit(0);
}
const expected = JSON.parse(readFileSync(values.expected, "utf8"));
let failed = 0;
expected.forEach((want, i) => {
  const got = outcomes[i];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(
      `✗ ${want.step}\n  expected ${JSON.stringify(want)}\n  received ${JSON.stringify(got)}`,
    );
  }
});
if (failed > 0 || outcomes.length !== expected.length) {
  console.error(`${failed} of ${expected.length} MCP vectors failed`);
  process.exit(1);
}
console.log(`MCP VECTORS OK (${expected.length} checks)`);
