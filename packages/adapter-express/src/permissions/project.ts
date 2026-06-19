import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Action, Role } from "@camis/permissions";

export interface ExpressFieldRule {
  field: string;
  access: "read" | "write";
  when?: Expression;
}
export interface ExpressPermissions {
  roles: string[];
  grants: Record<string, Record<string, Action[]>>;
  conditions: Record<string, Record<string, Expression>>;
  fieldRules: Record<string, Record<string, ExpressFieldRule[]>>;
  gaps: CapabilityGap[];
}

const recordFieldNames = (ct: ContentType): Set<string> =>
  new Set(ct.fields.filter((f) => f.type !== "relation").map((f) => f.name));

export const projectExpressPermissions = (doc: IrDocument, roles: Role[]): ExpressPermissions => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const grants: Record<string, Record<string, Action[]>> = {};
  const conditions: Record<string, Record<string, Expression>> = {};
  const fieldRules: Record<string, Record<string, ExpressFieldRule[]>> = {};
  const gaps: CapabilityGap[] = [];

  const flagEscaping = (
    expr: Expression,
    ctName: string,
    role: string,
    fieldOk: Set<string>,
  ): void => {
    const escaping = freeVars(expr).filter(
      (v) =>
        !(
          v.startsWith("user.") ||
          (v.startsWith("record.") && fieldOk.has(v.slice("record.".length)))
        ),
    );
    if (escaping.length > 0) {
      gaps.push({
        feature: "conditionContext",
        location: { contentType: ctName, rule: role },
        severity: "downgrade",
        message: `condition references ${escaping.join(", ")} outside user.* and record.<field>; it will deny`,
      });
    }
  };

  for (const role of [...roles].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType);
      if (!ct) continue;
      const fieldOk = recordFieldNames(ct);

      (grants[role.name] ??= {})[grant.contentType] = [
        ...new Set([...(grants[role.name]?.[grant.contentType] ?? []), ...grant.actions]),
      ].sort() as Action[];

      if (grant.actions.includes("publish" as Action)) {
        gaps.push({
          feature: "publishAction",
          location: { contentType: grant.contentType, rule: role.name },
          severity: "downgrade",
          message: `the "publish" action has no REST analog in the Express target; ignored`,
        });
      }

      if (grant.condition) {
        flagEscaping(grant.condition, grant.contentType, role.name, fieldOk);
        (conditions[role.name] ??= {})[grant.contentType] = grant.condition;
      }

      for (const fr of grant.fieldRules ?? []) {
        if (!fieldOk.has(fr.field)) {
          gaps.push({
            feature: "unknownFieldRule",
            location: { contentType: grant.contentType, field: fr.field, rule: role.name },
            severity: "downgrade",
            message: `field rule on "${grant.contentType}.${fr.field}" names a field absent or unsupported; ignored`,
          });
          continue;
        }
        if (fr.when) flagEscaping(fr.when, grant.contentType, role.name, fieldOk);
        const rule: ExpressFieldRule = fr.when
          ? { field: fr.field, access: fr.access, when: fr.when }
          : { field: fr.field, access: fr.access };
        ((fieldRules[role.name] ??= {})[grant.contentType] ??= []).push(rule);
      }
    }
  }

  return { roles: roles.map((r) => r.name).sort(), grants, conditions, fieldRules, gaps };
};
