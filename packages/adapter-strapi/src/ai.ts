import { stableJson, withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import { aiPlaceholders, type ContentType, type Field, type IrDocument } from "@camis/ir-schema";
import { strapiNames } from "./names";

type AiField = Field & { ai?: { model?: string; prompt: string; trigger: string } };
const aiOf = (f: Field): AiField["ai"] | undefined => (f as AiField).ai;

export const aiFieldContentTypes = (doc: IrDocument): ContentType[] =>
  doc.contentTypes.filter((ct) => ct.fields.some((f) => aiOf(f) !== undefined));

export const hasAiField = (doc: IrDocument): boolean => aiFieldContentTypes(doc).length > 0;

const PROVIDER = `// camis AI provider — REPLACE FOR PRODUCTION.
// Real impl: read process.env.ANTHROPIC_API_KEY and call the model SDK here.
export async function generate(model: string | undefined, prompt: string): Promise<string> {
  return \`[ai:\${model ?? "default"}] \${prompt.slice(0, 80)}\`;
}
`;

interface AiSpec {
  column: string;
  model?: string;
  prompt: string;
  trigger: string;
  sources: string[];
}

const specsFor = (ct: ContentType): AiSpec[] => {
  const specs: AiSpec[] = [];
  for (const f of ct.fields) {
    const a = aiOf(f);
    if (!a) continue;
    specs.push({
      column: f.name,
      ...(a.model !== undefined ? { model: a.model } : {}),
      prompt: a.prompt,
      trigger: a.trigger,
      sources: aiPlaceholders(a.prompt),
    });
  }
  return specs;
};

export const aiProviderFile = (): GeneratedFile => ({
  path: "src/ai/provider.ts",
  content: PROVIDER,
  mode: "seed",
});

export const aiLifecycleFile = (ct: ContentType): GeneratedFile => {
  const n = strapiNames(ct);
  const body = withMarker(`import { generate } from "../../../../ai/provider";

interface AiSpec {
  column: string;
  model?: string;
  prompt: string;
  trigger: string;
  sources: string[];
}

const SPECS: AiSpec[] = ${stableJson(specsFor(ct))};

async function populate(data: Record<string, unknown>, mode: "create" | "update"): Promise<void> {
  for (const f of SPECS) {
    const fires =
      f.trigger === "onCreate"
        ? mode === "create"
        : f.trigger === "onUpdate"
          ? mode === "update"
          : true;
    if (!fires) continue;
    if (mode === "update" && !f.sources.some((s) => s in data)) continue;
    let prompt = f.prompt;
    for (const s of f.sources) prompt = prompt.split(\`{{\${s}}}\`).join(String(data[s] ?? ""));
    try {
      data[f.column] = await generate(f.model, prompt);
    } catch (err) {
      console.error(\`AI generation failed for \${f.column}:\`, err);
    }
  }
}

export default {
  async beforeCreate(event: { params: { data: Record<string, unknown> } }) {
    await populate(event.params.data, "create");
  },
  async beforeUpdate(event: { params: { data: Record<string, unknown> } }) {
    await populate(event.params.data, "update");
  },
};
`);
  return {
    path: `src/api/${n.singularName}/content-types/${n.singularName}/lifecycles.ts`,
    content: body,
  };
};
