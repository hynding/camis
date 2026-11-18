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

/**
 * A condition's variable for the account that created the entry (Strapi's createdBy), on targets
 * that record one: `record.createdBy == user.id` is Strapi's admin::is-creator.
 */
export const CREATED_BY = "record.createdBy";

/**
 * A condition's variable that is true when the account that created the entry holds one of the
 * caller's roles, on targets that record a creator: `record.creatorSharesRole == true` is Strapi's
 * admin::has-same-role-as-creator.
 */
export const CREATOR_SHARES_ROLE = "record.creatorSharesRole";

/**
 * Services a plugin offers beside any content type, which a role may be given: listing the
 * locales, sending email, reading the roles. A target serving none of them reports a gap.
 */
export const SERVICES = ["email.send", "locales.list", "roles.read"] as const;
export type Service = (typeof SERVICES)[number];
export const service = z.enum(SERVICES);

/** The role a caller without a session acts as; every target that serves guests reads it. */
export const PUBLIC_ROLE = "public";

export const role = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Its users may sign in to the admin of a target that has one. */
  admin: z.boolean().optional(),
  grants: z.array(grant),
  /** The IR endpoints its users may call (the public role's: anyone without a session). */
  endpoints: z.array(z.string().min(1)).optional(),
  /** The plugin services its users may use (the public role's: anyone without a session). */
  services: z.array(service).optional(),
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
