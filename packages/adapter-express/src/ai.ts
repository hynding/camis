import { stableJson, withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import {
  aiPlaceholders,
  type Ai,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import { snakeColumn } from "./names";

// ---------------------------------------------------------------------------
// IR helpers
// ---------------------------------------------------------------------------

/** A field plus its resolved (non-null) ai annotation. */
export interface AiField {
  name: string;
  ai: Ai;
}

/** Narrow a field to one that has an ai annotation. */
const aiOf = (f: Field): AiField | null => {
  if ("ai" in f && f.ai != null) return { name: f.name, ai: f.ai as Ai };
  return null;
};

/** Return the snake-cased column names of all AI-annotated fields in a content type. */
export const aiColumnsOf = (ct: ContentType): string[] =>
  ct.fields.flatMap((f) => (aiOf(f) ? [snakeColumn(f.name)] : []));

/** True when any content type in the document carries at least one AI-annotated field. */
export const hasAiField = (doc: IrDocument): boolean =>
  doc.contentTypes.some((ct) => ct.fields.some((f) => aiOf(f) !== null));

// ---------------------------------------------------------------------------
// Provider seed (protected — never overwritten)
// ---------------------------------------------------------------------------

/** The offline stub provider emitted once as a seed file the user replaces in production. */
const PROVIDER = `// AI provider seam — replace with your real implementation.
// camis will never overwrite this file (mode: "seed").
//
// The ANTHROPIC_API_KEY env var is used by the default stub below.
// Swap the body for any provider (OpenAI, local Ollama, …).

const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

/**
 * Generate text from a rendered prompt.
 * @param prompt   The fully-rendered prompt (placeholders already substituted).
 * @param model    Optional model identifier; provider-specific.
 * @returns        The generated text.
 */
export async function generate(prompt: string, model?: string): Promise<string> {
  if (!apiKey) {
    // Offline default: return the prompt back so generated columns are never null.
    return \`[AI stub] \${prompt}\`;
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model ?? "claude-3-5-haiku-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(\`Anthropic API error \${response.status}: \${await response.text()}\`);
  }
  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find((b) => b.type === "text")?.text ?? "";
}
`;

// ---------------------------------------------------------------------------
// Per-field and per-type shape definitions
// ---------------------------------------------------------------------------

/** A single source placeholder mapped to its column name. */
interface AiSource {
  /** Field name as it appears in the prompt template (camelCase). */
  ph: string;
  /** DB column name (snake_case). */
  column: string;
}

/** The configuration record for one AI-annotated field. */
interface AiFieldSpec {
  column: string;
  trigger: string;
  model?: string;
  prompt: string;
  sources: AiSource[];
}

/** Build the CONFIG object for a single content type. */
const configFor = (ct: ContentType): AiFieldSpec[] => {
  const specs: AiFieldSpec[] = [];
  for (const f of ct.fields) {
    const annotation = aiOf(f);
    if (!annotation) continue;
    const placeholders = aiPlaceholders(annotation.ai.prompt);
    const sources: AiSource[] = placeholders.map((ph) => ({
      ph,
      column: snakeColumn(ph),
    }));
    const spec: AiFieldSpec = {
      column: snakeColumn(f.name),
      trigger: annotation.ai.trigger,
      prompt: annotation.ai.prompt,
      sources,
    };
    if (annotation.ai.model !== undefined) spec.model = annotation.ai.model;
    specs.push(spec);
  }
  return specs;
};

// ---------------------------------------------------------------------------
// populate.ts emitter
// ---------------------------------------------------------------------------

const populateModule = (doc: IrDocument): string => {
  const config: Record<string, AiFieldSpec[]> = {};
  for (const ct of doc.contentTypes) {
    const specs = configFor(ct);
    if (specs.length > 0) config[ct.name] = specs;
  }

  return withMarker(`import { generate } from "./provider";

// CONFIG is the machine-generated specification of every AI field in the schema.
// Edit the prompt templates or triggers in the IR and regenerate — do not edit here.
const CONFIG = ${stableJson(config).trimEnd()} as const;

type AiSource = { ph: string; column: string };
type AiFieldSpec = {
  column: string;
  trigger: string;
  model?: string;
  prompt: string;
  sources: readonly AiSource[];
};

type TriggerEvent = "onCreate" | "onUpdate" | "onCreateOrUpdate";

/** Render a prompt template by substituting {{placeholder}} with row values. */
const renderPrompt = (template: string, row: Record<string, unknown>): string =>
  template.replace(/\\{\\{\\s*([a-z][A-Za-z0-9]*)\\s*\\}\\}/g, (_m, ph: string) => {
    const col = (CONFIG as Record<string, AiFieldSpec[]>)[Object.keys(CONFIG)[0]!]
      ?.find((s) => s.sources.some((src: AiSource) => src.ph === ph))
      ?.sources.find((src: AiSource) => src.ph === ph)?.column ?? ph;
    return String(row[col] ?? "");
  });

/**
 * Populate AI-generated fields on a row for the given content type and trigger event.
 *
 * @param contentType  The IR content-type name (e.g. "Article").
 * @param trigger      The event that is firing.
 * @param row          The current row values (used to resolve prompt placeholders).
 * @returns            A partial record of \`{ column: generatedValue }\` entries to merge.
 */
export async function populateAiFields(
  contentType: string,
  trigger: TriggerEvent,
  row: Record<string, unknown>,
): Promise<Record<string, string>> {
  const specs: readonly AiFieldSpec[] | undefined =
    (CONFIG as Record<string, readonly AiFieldSpec[]>)[contentType];
  if (!specs) return {};
  const result: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.trigger !== trigger && spec.trigger !== "onCreateOrUpdate") continue;
    if (trigger === "onCreateOrUpdate" && spec.trigger !== "onCreateOrUpdate") continue;
    const prompt = renderPrompt(spec.prompt, row);
    result[spec.column] = await generate(prompt, spec.model);
  }
  return result;
}
`);
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Emit the AI provider seam and populate module for a document that has AI fields. */
export const aiFiles = (doc: IrDocument): GeneratedFile[] => [
  { path: "src/ai/provider.ts", content: PROVIDER, mode: "seed" },
  { path: "src/ai/populate.ts", content: populateModule(doc) },
];
