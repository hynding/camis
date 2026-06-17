import { fail, ok, parseDocument, type IrDocument, type Result } from "@camis/ir-schema";
import { normalize } from "./normalize";
import { validateInvariants } from "./invariants";

export const validate = (input: unknown): Result<IrDocument> => {
  const parsed = parseDocument(input);
  if (!parsed.ok) return parsed;
  const normalized = normalize(parsed.value);
  const invariantErrors = validateInvariants(normalized);
  return invariantErrors.length > 0 ? fail(invariantErrors) : ok(normalized);
};
