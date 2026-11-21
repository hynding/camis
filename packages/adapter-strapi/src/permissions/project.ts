import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import type { Action, Role } from "@camis/permissions";
import { SERVICE_ACTIONS, strapiNames } from "@camis/strapi-schema";
import {
  API_ACTION_SUFFIXES,
  FIELD_ACCESS_ACTIONS,
  FILE_ADMIN_ACTIONS,
  FILE_API_ACTIONS,
  PLUGIN_USER_UID,
  USER_API_ACTIONS,
  PUBLIC_API_ACTIONS,
  STRAPI_ACTION_UID,
  USER_RELATION_WRITE_ACTION,
} from "./actions";
import { endpointHandler } from "../hooks/endpoints";
import { conditionName } from "./condition-name";

export const USER_CONTEXT = ["user.id", "user.email", "user.role"] as const;

export interface PermissionEntry {
  action: string;
  /** The content type's uid; null for the media library's actions. */
  subject: string | null;
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
  a.action === b.action
    ? (a.subject ?? "").localeCompare(b.subject ?? "")
    : a.action.localeCompare(b.action);

export const projectPermissions = (doc: IrDocument, roles: Role[]): ProjectionResult => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const conditions = new Map<string, Expression>();
  const gaps: CapabilityGap[] = [];

  const register = (
    predicate: Expression,
    where: { contentType: string; field?: string; rule: string },
    adminPanelOnly: boolean,
  ): string => {
    const name = conditionName(predicate);
    conditions.set(name, predicate);
    // A non-admin role's grant condition is enforced by the content API, which reads record.*;
    // only where the admin panel is the sole enforcer does its user-only context matter.
    if (!adminPanelOnly) return name;
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
      if (ct.builtin === "file") {
        if (grant.condition !== undefined) {
          gaps.push({
            feature: "fileGrantCondition",
            location: { contentType: grant.contentType, rule: role.name },
            severity: "downgrade",
            message: `"${role.name}" grant on the media library is conditioned; Strapi's upload actions take no custom condition, so it applies to every file`,
          });
        }
        const actions = new Set(grant.actions.flatMap((act) => FILE_ADMIN_ACTIONS[act]));
        for (const action of actions) permissions.push({ action, subject: null });
        continue;
      }
      const subject = ct.builtin === "user" ? PLUGIN_USER_UID : strapiNames(ct).uid;
      const grantConditions = grant.condition
        ? [
            register(
              grant.condition,
              { contentType: grant.contentType, rule: role.name },
              role.admin === true,
            ),
          ]
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
              register(
                fr.when,
                { contentType: grant.contentType, field: fr.field, rule: role.name },
                true,
              ),
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
  /**
   * The plugin actions camis grants on its own account, which the bootstrap therefore also
   * revokes from a role it no longer grants them to; every other plugin action is Strapi's.
   */
  managed: string[];
  gaps: CapabilityGap[];
}

/**
 * Projects IR roles onto the users-permissions REST API's own role/permission model — distinct
 * from `projectPermissions`'s admin-panel projection: users-permissions actions carry no
 * conditions and have no `publish` action (Strapi 5 publishes via `update` + a `status` param).
 * A grant's condition and assign are enforced by the generated controllers (`api-enforcement`).
 */
export const projectApiRoles = (doc: IrDocument, roles: Role[]): ApiRoleProjection => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const gaps: CapabilityGap[] = [];
  const builtinUsers = new Set(
    doc.contentTypes.filter((ct) => ct.builtin === "user").map((ct) => ct.name),
  );
  const userRelations = (name: string): string[] =>
    (byName.get(name)?.fields ?? [])
      .filter((f) => f.type === "relation" && builtinUsers.has(f.target))
      .map((f) => f.name);
  /** The client writes a user relation: one no grant of the role on the type assigns. */
  const writesUserRelation = (role: Role, name: string): boolean => {
    const assigned = new Set(
      role.grants.filter((g) => g.contentType === name).flatMap((g) => Object.keys(g.assign ?? {})),
    );
    return userRelations(name).some((f) => !assigned.has(f));
  };
  const WRITE_ACTIONS: Action[] = ["create", "update"];

  const projected = roles.map((role): ApiRoleGrant => {
    const actions = new Set<string>();
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType)!;
      if (ct.builtin === "file") {
        for (const act of grant.actions)
          for (const action of FILE_API_ACTIONS[act]) actions.add(action);
        continue;
      }
      if (ct.builtin === "user") {
        for (const act of grant.actions)
          for (const action of USER_API_ACTIONS[act]) actions.add(action);
        continue;
      }
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
        writesUserRelation(role, grant.contentType) &&
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
    }
    for (const name of role.endpoints ?? []) {
      const endpoint = (doc.endpoints ?? []).find((e) => e.name === name);
      const ct = endpoint === undefined ? undefined : byName.get(endpoint.contentType);
      if (endpoint !== undefined && ct !== undefined) actions.add(endpointHandler(endpoint, ct));
    }
    for (const service of role.services ?? [])
      for (const action of SERVICE_ACTIONS[service]) actions.add(action);
    return { type: role.name, actions: [...actions].sort() };
  });

  return {
    roles: projected,
    public: [...PUBLIC_API_ACTIONS],
    managed: builtinUsers.size > 0 ? [USER_RELATION_WRITE_ACTION] : [],
    gaps,
  };
};
