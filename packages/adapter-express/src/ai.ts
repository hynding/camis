import { stableJson, withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import { aiPlaceholders, type ContentType, type Field, type IrDocument } from "@camis/ir-schema";
import { snakeColumn } from "./names";

type AiField = Field & { ai?: { model?: string; prompt: string; trigger: string } };

const aiOf = (f: Field): AiField["ai"] | undefined => (f as AiField).ai;

export const aiColumnsOf = (ct: ContentType): string[] =>
  ct.fields.filter((f) => aiOf(f) !== undefined).map((f) => snakeColumn(f.name));

export const hasAiField = (doc: IrDocument): boolean =>
  doc.contentTypes.some((ct) => ct.fields.some((f) => aiOf(f) !== undefined));

// Protected provider seam: deterministic + offline by default so dev/CI need no network or API key.
const PROVIDER = `// camis AI provider — REPLACE FOR PRODUCTION.
// Real impl: read process.env.ANTHROPIC_API_KEY and call the model SDK here.
export async function generate(model: string | undefined, prompt: string): Promise<string> {
  return \`[ai:\${model ?? "default"}] \${prompt.slice(0, 80)}\`;
}
`;

interface AiSource {
  ph: string;
  col: string;
}
interface AiFieldSpec {
  column: string;
  model?: string;
  prompt: string;
  trigger: string;
  sources: AiSource[];
}

const configFor = (doc: IrDocument): Record<string, AiFieldSpec[]> => {
  const cfg: Record<string, AiFieldSpec[]> = {};
  for (const ct of doc.contentTypes) {
    const specs: AiFieldSpec[] = [];
    for (const f of ct.fields) {
      const a = aiOf(f);
      if (!a) continue;
      const sources = aiPlaceholders(a.prompt).map((ph) => ({ ph, col: snakeColumn(ph) }));
      specs.push({
        column: snakeColumn(f.name),
        ...(a.model !== undefined ? { model: a.model } : {}),
        prompt: a.prompt,
        trigger: a.trigger,
        sources,
      });
    }
    if (specs.length > 0) cfg[ct.name] = specs;
  }
  return cfg;
};

const populateModule = (doc: IrDocument): string =>
  withMarker(`import { generate } from "./provider";

interface AiSource {
  ph: string;
  col: string;
}
interface AiFieldSpec {
  column: string;
  model?: string;
  prompt: string;
  trigger: string;
  sources: AiSource[];
}

const CONFIG: Record<string, AiFieldSpec[]> = ${stableJson(configFor(doc))};

// Populate AI fields on a record before it is persisted. Best-effort: a provider error is logged,
// never fatal. On update, a field regenerates only when one of its sources is present in the payload.
export async function populateAiFields(
  type: string,
  data: Record<string, unknown>,
  mode: "create" | "update",
): Promise<Record<string, unknown>> {
  for (const f of CONFIG[type] ?? []) {
    const fires =
      f.trigger === "onCreate"
        ? mode === "create"
        : f.trigger === "onUpdate"
          ? mode === "update"
          : true;
    if (!fires) continue;
    if (mode === "update" && !f.sources.some((s) => s.col in data)) continue;
    let prompt = f.prompt;
    for (const s of f.sources) prompt = prompt.split(\`{{\${s.ph}}}\`).join(String(data[s.col] ?? ""));
    try {
      data[f.column] = await generate(f.model, prompt);
    } catch (err) {
      console.error(\`AI generation failed for \${type}.\${f.column}:\`, err);
    }
  }
  return data;
}
`);

export const aiFiles = (doc: IrDocument): GeneratedFile[] => [
  { path: "src/ai/provider.ts", content: PROVIDER, mode: "seed" },
  { path: "src/ai/populate.ts", content: populateModule(doc) },
];
