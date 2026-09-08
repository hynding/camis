import { fail, ok, type IrDocument, type IrError, type Result } from "@camis/ir-schema";
import type { Role } from "./model";

export interface IrBundle {
  document: IrDocument;
  roles: Role[];
  /** Role assigned to newly registered users (Strapi API style). */
  defaultRole?: string;
}

/** Cross-check that every grant/field-rule references an existing content type and field. */
export const validateBundle = (bundle: IrBundle): Result<IrBundle> => {
  const byName = new Map(bundle.document.contentTypes.map((ct) => [ct.name, ct]));
  const errors: IrError[] = [];
  bundle.roles.forEach((role, ri) => {
    role.grants.forEach((grant, gi) => {
      const ct = byName.get(grant.contentType);
      if (!ct) {
        errors.push({
          code: "unknown_grant_content_type",
          message: `grant references unknown content type "${grant.contentType}"`,
          location: { contentType: grant.contentType, rule: role.name },
          path: ["roles", ri, "grants", gi, "contentType"],
        });
        return;
      }
      const fields = new Set(ct.fields.map((f) => f.name));
      grant.fieldRules?.forEach((fr, fi) => {
        if (!fields.has(fr.field)) {
          errors.push({
            code: "unknown_field_rule_field",
            message: `field rule references unknown field "${grant.contentType}.${fr.field}"`,
            location: { contentType: grant.contentType, field: fr.field, rule: role.name },
            path: ["roles", ri, "grants", gi, "fieldRules", fi, "field"],
          });
        }
      });
      const userTypes = new Set(
        bundle.document.contentTypes.filter((c) => c.builtin === "user").map((c) => c.name),
      );
      Object.keys(grant.assign ?? {}).forEach((name) => {
        const f = ct.fields.find((x) => x.name === name);
        if (!f) {
          errors.push({
            code: "unknown_assign_field",
            message: `assign references unknown field "${grant.contentType}.${name}"`,
            location: { contentType: grant.contentType, field: name, rule: role.name },
            path: ["roles", ri, "grants", gi, "assign", name],
          });
          return;
        }
        const owning =
          f.type === "relation" &&
          (f.relationKind === "manyToOne" || f.relationKind === "oneToOne") &&
          userTypes.has(f.target);
        if (!owning) {
          errors.push({
            code: "assign_not_user_relation",
            message: `assign target "${grant.contentType}.${name}" must be a manyToOne/oneToOne relation to the builtin user type`,
            location: { contentType: grant.contentType, field: name, rule: role.name },
            path: ["roles", ri, "grants", gi, "assign", name],
          });
        }
      });
    });
  });
  if (
    bundle.defaultRole !== undefined &&
    !bundle.roles.some((r) => r.name === bundle.defaultRole)
  ) {
    errors.push({
      code: "unknown_default_role",
      message: `defaultRole "${bundle.defaultRole}" does not name a declared role`,
      location: { rule: bundle.defaultRole },
      path: ["defaultRole"],
    });
  }
  return errors.length > 0 ? fail(errors) : ok(bundle);
};
