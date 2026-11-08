import { withMarker } from "@camis/adapter-kernel";
import type { Hook, HookTrigger } from "@camis/ir-schema";
import { hookSlug } from "./names";

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

type Lifecycle = Exclude<HookTrigger, "onPublish">;

// Each Strapi lifecycle, in the order a record meets them, with what its event carries: the data
// about to be written, the row written, or (before a delete) only the filter that finds it.
const LIFECYCLES: { name: Lifecycle; event: "data" | "result" | "where" }[] = [
  { name: "beforeCreate", event: "data" },
  { name: "afterCreate", event: "result" },
  { name: "beforeUpdate", event: "data" },
  { name: "afterUpdate", event: "result" },
  { name: "beforeDelete", event: "where" },
  { name: "afterDelete", event: "result" },
];

const EVENT_TYPE = {
  data: "{ params: { data?: Record<string, unknown> } }",
  result: "{ result?: Record<string, unknown> }",
  where: "{ params: { where?: Record<string, unknown> } }",
};

const RECORD = { data: "data", result: "result", where: "entry" };

const run = (h: Hook, record: string): string[] => {
  const call = `${lower(h.name)}.run({ ${h.input.map((f) => `${f.name}: ${record}.${f.name} as never`).join(", ")} });`;
  if (h.output.length === 0) return [call];
  return [`const out = ${call}`, ...h.output.map((f) => `${record}.${f.name} = out.${f.name};`)];
};

const guarded = (condition: string, lines: string[]): string =>
  [`    if (${condition}) {`, ...lines.map((l) => `      ${l}`), "    }"].join("\n");

// Strapi's publish writes publishedAt on the update; the hook runs on that write.
const blocks = (h: Hook, lifecycle: Lifecycle, record: string): string[] => {
  if (h.trigger === "onPublish")
    return lifecycle === "beforeUpdate"
      ? [guarded("data && data.publishedAt", run(h, record))]
      : [];
  return h.trigger === lifecycle ? [guarded(record, run(h, record))] : [];
};

const opening = (event: "data" | "result" | "where", uid: string): string =>
  event === "data"
    ? "    const { data } = event.params;"
    : event === "result"
      ? "    const { result } = event;"
      : `    const entry = await strapi.db.query("${uid}").findOne({ where: event.params.where });`;

/** A content type's lifecycles.ts, which runs each of its hooks on the lifecycle it names. */
export const emitHookLifecycles = (hooks: Hook[], uid: string): string => {
  const methods = LIFECYCLES.map(({ name, event }) => ({
    name,
    event,
    body: hooks.flatMap((h) => blocks(h, name, RECORD[event])),
  }))
    .filter((m) => m.body.length > 0)
    .map(
      ({ name, event, body }) =>
        `  async ${name}(event: ${EVENT_TYPE[event]}) {\n${opening(event, uid)}\n${body.join("\n")}\n  },`,
    )
    .join("\n");
  const imports = [...new Set(hooks.map((h) => h.name))]
    .sort((a, b) => hookSlug(a).localeCompare(hookSlug(b)))
    .map((n) => `import { ${lower(n)} } from "../../../../hooks/${hookSlug(n)}";`)
    .join("\n");
  return withMarker(`${imports}\n\nexport default {\n${methods}\n};\n`);
};
