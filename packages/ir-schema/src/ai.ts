import { z } from "zod";

export const AI_TRIGGERS = ["onCreate", "onUpdate", "onCreateOrUpdate"] as const;
export type AiTrigger = (typeof AI_TRIGGERS)[number];

export const ai = z.object({
  model: z.string().min(1).optional(), // optional, provider-opaque pass-through
  prompt: z.string().min(1), // template with {{field}} placeholders
  trigger: z.enum(AI_TRIGGERS),
});
export type Ai = z.infer<typeof ai>;

// Extract the unique {{placeholder}} field names from a prompt template (the derived source set).
export const aiPlaceholders = (prompt: string): string[] => {
  const re = /\{\{\s*([a-z][A-Za-z0-9]*)\s*\}\}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) out.push(m[1]!);
  return [...new Set(out)];
};
