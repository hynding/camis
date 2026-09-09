import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import type { Action, Role } from "@camis/permissions";
import { strapiNames } from "../names";
import {
  API_ACTION_SUFFIXES,
  FIELD_ACCESS_ACTIONS,
  PUBLIC_API_ACTIONS,
  STRAPI_ACTION_UID,
  USER_RELATION_WRITE_ACTION,
} from "./actions";
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
  /**
   * Always present, empty when the IR role carries none: the generated bootstrap reads it off the
   * roles.json import, and TypeScript types that module from the emitted JSON, so an omitted key
   * breaks the compile of the very project this emits.
   */
  description: string;
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
    return { name: role.name, description: role.description ?? "", permissions };
  });

  const named = [...conditions.entries()]
    .map(([name, predicate]): NamedCondition => ({ name, predicate }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { roles: emittedRoles, conditions: named, gaps };
};

export interface ApiRoleGrant {
  type: string;
  actions: string[];
}
export interface ApiRoleProjection {
  roles: ApiRoleGrant[];
  public: string[];
  gaps: CapabilityGap[];
}

/**
 * Projects IR roles onto the users-permissions REST API's own role/permission model — distinct
 * from `projectPermissions`'s admin-panel projection: users-permissions actions carry no
 * conditions and have no `publish` action (Strapi 5 publishes via `update` + a `status` param).
 */
export const projectApiRoles = (doc: IrDocument, roles: Role[]): ApiRoleProjection => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const gaps: CapabilityGap[] = [];
  const builtinUsers = new Set(
    doc.contentTypes.filter((ct) => ct.builtin === "user").map((ct) => ct.name),
  );
  const ownsUserRelation = (name: string): boolean =>
    (byName.get(name)?.fields ?? []).some(
      (f) => f.type === "relation" && builtinUsers.has(f.target),
    );
  const WRITE_ACTIONS: Action[] = ["create", "update"];

  const projected = roles.map((role): ApiRoleGrant => {
    const actions = new Set<string>();
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType)!;
      const uid = strapiNames(ct).uid;
      for (const act of grant.actions) {
        for (const suffix of API_ACTION_SUFFIXES[act] ?? []) {
          actions.add(`${uid}.${suffix}`);
        }
      }
      if (grant.actions.includes("publish") && !grant.actions.includes("update")) {
        gaps.push({
          feature: "publishAction",
          location: { contentType: grant.contentType, rule: role.name },
          severity: "downgrade",
          message: `"${role.name}" grant on "${grant.contentType}" publishes without update; the users-permissions API has no separate publish action`,
        });
      }
      if (
        ownsUserRelation(grant.contentType) &&
        grant.actions.some((act) => WRITE_ACTIONS.includes(act))
      ) {
        actions.add(USER_RELATION_WRITE_ACTION);
        gaps.push({
          feature: "userRelationWrite",
          location: { contentType: grant.contentType, rule: role.name },
          severity: "downgrade",
          message: `"${role.name}" writes a relation to the built-in user on "${grant.contentType}"; Strapi validates that against the user type's find scope, so the role also gets ${USER_RELATION_WRITE_ACTION} — which exposes every user's username and email at GET /api/users${role.name === "public" ? ", and since this is the public role, unauthenticated" : ""}`,
        });
      }
      if (grant.condition) {
        gaps.push({
          feature: "apiGrantCondition",
          location: { contentType: grant.contentType, rule: role.name },
          severity: "downgrade",
          message: `"${role.name}" grant on "${grant.contentType}" is unconditioned at the users-permissions API; conditions apply to the admin panel only`,
        });
      }
    }
    return { type: role.name, actions: [...actions].sort() };
  });

  return { roles: projected, public: [...PUBLIC_API_ACTIONS], gaps };
};
