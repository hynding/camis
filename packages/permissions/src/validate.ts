import { fail, ok, type IrDocument, type IrError, type Result } from "@camis/ir-schema";
import type { Role } from "./model";

export interface IrBundle {
  document: IrDocument;
  roles: Role[];
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
    });
  });
  return errors.length > 0 ? fail(errors) : ok(bundle);
};
