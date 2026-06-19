import { validate } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { applyMutations } from "./apply";
import type { AiClient } from "./client";
import { mutations, type AuthoringError, type Mutation } from "./mutation";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "./prompts";

export interface AuthorRequest {
  instruction: string;
  document: IrDocument;
  client: AiClient;
  maxRepairs?: number;
}

export type AuthorResult =
  | { ok: true; document: IrDocument; ops: Mutation[] }
  | { ok: false; errors: AuthoringError[] };

const schemaErrors = (issues: { message: string; path: (string | number)[] }[]): AuthoringError[] =>
  issues.map((i) => ({
    code: "invalid_document",
    message: i.message,
    location: {},
    path: [...i.path],
  }));

export const author = async (req: AuthorRequest): Promise<AuthorResult> => {
  const { instruction, document, client } = req;
  const maxRepairs = req.maxRepairs ?? 2;
  const system = buildSystemPrompt();
  let user = buildUserPrompt(document, instruction);

  for (let attempt = 0; ; attempt++) {
    const raw = await client.propose({ system, user });
    const parsed = mutations.safeParse(raw);

    if (!parsed.success) {
      const errors = schemaErrors(parsed.error.issues);
      if (attempt >= maxRepairs) return { ok: false, errors };
      user = buildRepairPrompt(document, instruction, [], errors);
      continue;
    }

    const ops = parsed.data;
    const applied = applyMutations(document, ops);
    const validated = validate(applied.document);
    const errors: AuthoringError[] = [...applied.errors, ...(validated.ok ? [] : validated.errors)];

    if (errors.length === 0 && validated.ok) {
      return { ok: true, document: validated.value, ops };
    }
    if (attempt >= maxRepairs) return { ok: false, errors };
    user = buildRepairPrompt(document, instruction, ops, errors);
  }
};
