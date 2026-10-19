import { z } from "zod";
import { expression } from "@camis/expr";
import { fieldName, typeName } from "@camis/ir-schema";
import { action } from "./actions";

export const fieldRule = z.object({
  field: fieldName,
  access: z.enum(["read", "write"]),
  when: expression.optional(),
});
export type FieldRule = z.infer<typeof fieldRule>;

export const grant = z.object({
  contentType: typeName,
  actions: z.array(action).min(1),
  fieldRules: z.array(fieldRule).optional(),
  condition: expression.optional(),
  // Create-time assignment: fill the named owning relation from the authenticated user.
  assign: z.record(fieldName, z.literal("user.id")).optional(),
});
export type Grant = z.infer<typeof grant>;

/** The role a caller without a session acts as; every target that serves guests reads it. */
export const PUBLIC_ROLE = "public";

export const role = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  grants: z.array(grant),
});
export type Role = z.infer<typeof role>;

export const rolesFile = z.object({
  defaultRole: z.string().min(1).optional(),
  roles: z.array(role),
});
export type RolesFile = z.infer<typeof rolesFile>;

export type ParsedRolesFile =
  | { ok: true; value: RolesFile }
  | { ok: false; issues: readonly string[] };

/**
 * A roles file is either a bare `Role[]` (legacy) or `{ defaultRole?, roles }`.
 *
 * When neither parses, the reported issues are the object form's: it is the documented shape, so
 * its diagnostics locate the actual mistake, whereas the bare-array attempt on an object-shaped
 * file only ever says "expected array".
 */
export const parseRolesFile = (raw: unknown): ParsedRolesFile => {
  const bare = z.array(role).safeParse(raw);
  if (bare.success) return { ok: true, value: { roles: bare.data } };
  const obj = rolesFile.safeParse(raw);
  if (obj.success) return { ok: true, value: obj.data };
  return {
    ok: false,
    issues: obj.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
};
