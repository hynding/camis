import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { filamentNames } from "../names";
import { permissionKey, POLICY_METHODS, USER_CONTEXT } from "./keys";

export interface PolicyMethodSpec {
  method: string;
  key: string;
  record: boolean;
  condition?: Expression;
}
export interface PolicySpec {
  contentType: string;
  model: string;
  methods: PolicyMethodSpec[];
}
export interface FilamentPermissions {
  permissionKeys: string[];
  roleGrants: { role: string; keys: string[] }[];
  policies: PolicySpec[];
  gaps: CapabilityGap[];
}

const recordVars = (ct: ContentType): Set<string> =>
  new Set(ct.fields.filter((f) => f.type !== "relation").map((f) => `record.${f.name}`));

export const projectFilamentPermissions = (doc: IrDocument, roles: Role[]): FilamentPermissions => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const keys = new Set<string>();
  const gaps: CapabilityGap[] = [];
  const roleGrants: { role: string; keys: string[] }[] = [];
  const condByCa = new Map<string, Expression>();
  const actionsByCt = new Map<string, Set<string>>();

  for (const role of roles) {
    const roleKeys = new Set<string>();
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType);
      if (!ct) continue;
      if (grant.fieldRules && grant.fieldRules.length > 0) {
        for (const fr of grant.fieldRules) {
          gaps.push({
            feature: "fieldRule",
            location: { contentType: grant.contentType, field: fr.field, rule: role.name },
            severity: "downgrade",
            message: `field-level rule on "${grant.contentType}.${fr.field}" is not supported by the Filament target`,
          });
        }
      }
      if (grant.condition) {
        const allowed = new Set<string>([...USER_CONTEXT, ...recordVars(ct)]);
        const escaping = freeVars(grant.condition).filter((v) => !allowed.has(v));
        if (escaping.length > 0) {
          gaps.push({
            feature: "conditionContext",
            location: { contentType: grant.contentType, rule: role.name },
            severity: "downgrade",
            message: `condition references ${escaping.join(", ")} outside user.* and record.<field>; it will deny`,
          });
        }
      }
      for (const action of grant.actions) {
        const key = permissionKey(grant.contentType, action);
        keys.add(key);
        roleKeys.add(key);
        const set = actionsByCt.get(grant.contentType) ?? new Set<string>();
        set.add(action);
        actionsByCt.set(grant.contentType, set);
        if (grant.condition) {
          const ca = `${grant.contentType}.${action}`;
          const existing = condByCa.get(ca);
          if (existing && JSON.stringify(existing) !== JSON.stringify(grant.condition)) {
            gaps.push({
              feature: "conditionConflict",
              location: { contentType: grant.contentType, rule: role.name },
              severity: "downgrade",
              message: `multiple roles grant "${ca}" with different conditions; only the first is enforced`,
            });
          } else if (!existing) {
            condByCa.set(ca, grant.condition);
          }
        }
      }
    }
    roleGrants.push({ role: role.name, keys: [...roleKeys].sort() });
  }

  const policies: PolicySpec[] = [...actionsByCt.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ctName, actions]): PolicySpec => {
      const methods: PolicyMethodSpec[] = [];
      for (const action of [...actions].sort()) {
        for (const pm of POLICY_METHODS[action as keyof typeof POLICY_METHODS]) {
          const condition = condByCa.get(`${ctName}.${action}`);
          methods.push({
            method: pm.method,
            key: permissionKey(ctName, action as never),
            record: pm.record,
            ...(condition ? { condition } : {}),
          });
        }
      }
      return {
        contentType: ctName,
        model: filamentNames(byName.get(ctName) as ContentType).model,
        methods,
      };
    });

  return {
    permissionKeys: [...keys].sort(),
    roleGrants: roleGrants.sort((a, b) => a.role.localeCompare(b.role)),
    policies,
    gaps,
  };
};
