import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { strapiNames } from "../names";
import { FIELD_ACCESS_ACTIONS, STRAPI_ACTION_UID } from "./actions";
import { conditionName } from "./condition-name";

export const USER_CONTEXT = ["user.id", "user.email", "user.role"] as const;

export interface PermissionEntry {
  action: string;
  subject: string;
  properties?: { fields: string[] };
  conditions?: string[];
}
export interface EmittedRole {
  name: string;
  description?: string;
  permissions: PermissionEntry[];
}
export interface NamedCondition {
  name: string;
  predicate: Expression;
}
export interface ProjectionResult {
  roles: EmittedRole[];
  conditions: NamedCondition[];
  gaps: CapabilityGap[];
}

const sortEntries = (a: PermissionEntry, b: PermissionEntry): number =>
  a.action === b.action ? a.subject.localeCompare(b.subject) : a.action.localeCompare(b.action);

export const projectPermissions = (doc: IrDocument, roles: Role[]): ProjectionResult => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const conditions = new Map<string, Expression>();
  const gaps: CapabilityGap[] = [];

  const register = (
    predicate: Expression,
    where: { contentType: string; field?: string; rule: string },
  ): string => {
    const name = conditionName(predicate);
    conditions.set(name, predicate);
    const escaping = freeVars(predicate).filter(
      (v) => !USER_CONTEXT.includes(v as (typeof USER_CONTEXT)[number]),
    );
    if (escaping.length > 0) {
      gaps.push({
        feature: "conditionContext",
        location: {
          contentType: where.contentType,
          rule: where.rule,
          ...(where.field !== undefined ? { field: where.field } : {}),
        },
        severity: "downgrade",
        message: `condition references ${escaping.join(", ")} outside the user.* context; it will deny at runtime`,
      });
    }
    return name;
  };

  const emittedRoles = roles.map((role): EmittedRole => {
    const permissions: PermissionEntry[] = [];
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType)!;
      const subject = strapiNames(ct).uid;
      const grantConditions = grant.condition
        ? [register(grant.condition, { contentType: grant.contentType, rule: role.name })]
        : undefined;

      for (const act of grant.actions) {
        if (act === "publish" && !ct.options?.draftPublish) {
          gaps.push({
            feature: "publishWithoutDraft",
            location: { contentType: grant.contentType, rule: role.name },
            severity: "downgrade",
            message: `"${grant.contentType}" has no draftPublish; publish grant is inert`,
          });
        }
        permissions.push({
          action: STRAPI_ACTION_UID[act],
          subject,
          ...(grantConditions ? { conditions: grantConditions } : {}),
        });
      }

      for (const fr of grant.fieldRules ?? []) {
        const condNames = fr.when
          ? [
              register(fr.when, {
                contentType: grant.contentType,
                field: fr.field,
                rule: role.name,
              }),
            ]
          : undefined;
        for (const act of FIELD_ACCESS_ACTIONS[fr.access]) {
          permissions.push({
            action: STRAPI_ACTION_UID[act],
            subject,
            properties: { fields: [fr.field] },
            ...(condNames ? { conditions: condNames } : {}),
          });
        }
      }
    }
    permissions.sort(sortEntries);
    return {
      name: role.name,
      ...(role.description ? { description: role.description } : {}),
      permissions,
    };
  });

  const named = [...conditions.entries()]
    .map(([name, predicate]): NamedCondition => ({ name, predicate }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { roles: emittedRoles, conditions: named, gaps };
};
