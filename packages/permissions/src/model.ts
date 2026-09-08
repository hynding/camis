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

/** A roles file is either a bare `Role[]` (legacy) or `{ defaultRole?, roles }`. */
export const parseRolesFile = (raw: unknown): RolesFile | undefined => {
  const bare = z.array(role).safeParse(raw);
  if (bare.success) return { roles: bare.data };
  const obj = rolesFile.safeParse(raw);
  return obj.success ? obj.data : undefined;
};
