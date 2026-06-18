import { withMarker } from "@camis/adapter-kernel";
import type { Hook } from "@camis/ir-schema";
import { hookSlug } from "./names";

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

// Generated invocation: on the publish transition, run the hook and apply its output back to the record.
export const emitHookLifecycle = (h: Hook): string =>
  withMarker(
    `import { ${lower(h.name)} } from "../../../../hooks/${hookSlug(h.name)}";

export default {
  async beforeUpdate(event: { params: { data?: Record<string, unknown> } }) {
    const { data } = event.params;
    if (data && data.publishedAt) {
      const out = ${lower(h.name)}.run({ ${h.input.map((f) => `${f.name}: data.${f.name} as never`).join(", ")} });
${h.output.map((f) => `      data.${f.name} = out.${f.name};`).join("\n")}
    }
  },
};
`,
  );
