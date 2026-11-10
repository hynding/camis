import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import { CREATED_BY, type Role } from "@camis/permissions";
import { filamentNames } from "../names";
import { permissionKey, POLICY_METHODS, USER_CONTEXT } from "./keys";

/** Roles that hold an action only where `condition` holds. */
export interface ConditionGroup {
  roles: string[];
  condition: Expression;
}

export interface PolicyMethodSpec {
  method: string;
  key: string;
  record: boolean;
  /**
   * Names of the roles whose grants hold `key`, sorted. A layout with no permission table
   * (Strapi) gates on role membership instead of a Spatie check; the Laravel layout ignores it.
   */
  roles: string[];
  /**
   * The roles holding `key` only under a condition, grouped by condition; a role of `roles` named
   * in none holds it outright. Absent when every role holds it outright.
   */
  conditions?: ConditionGroup[];
}
export interface PolicySpec {
  contentType: string;
  model: string;
  methods: PolicyMethodSpec[];
}
/** Who an admin list shows every row to, and which rows it shows the other roles reading it. */
export interface AdminReadScope {
  unconditional: string[];
  conditions: ConditionGroup[];
}
export interface FilamentPermissions {
  permissionKeys: string[];
  roleGrants: { role: string; keys: string[] }[];
  policies: PolicySpec[];
  /** The content API's list scope per type, from the roles of its users (not admin roles). */
  readConditions: Map<string, Expression>;
  /** The admin list's scope per type where an admin role reads it under a condition. */
  adminReadScopes: Map<string, AdminReadScope>;
  assigns: Map<string, string[]>;
  gaps: CapabilityGap[];
}

export interface ProjectionOptions {
  /** The target records who created an entry, which an admin role's condition may name. */
  creators?: boolean;
}

const recordVars = (ct: ContentType): Set<string> =>
  new Set([
    ...ct.fields
      .filter((f) => f.type !== "relation" && f.type !== "component")
      .map((f) => `record.${f.name}`),
    ...ct.fields
      .filter(
        (f) =>
          f.type === "relation" &&
          (f.relationKind === "manyToOne" || f.relationKind === "oneToOne"),
      )
      .map((f) => `record.${f.name}Id`),
  ]);

/**
 * How one role holds one action on one type: outright (`true`), or only where one of its
 * conditions holds. A grant of it with no condition makes the role hold it outright.
 */
type Holding = true | Expression[];

const sameExpression = (a: Expression, b: Expression): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const holdingCondition = (conditions: Expression[]): Expression =>
  conditions.length === 1 ? conditions[0]! : { kind: "or", args: conditions };

/** Groups the roles holding an action under a condition by that condition, in role order. */
const conditionGroups = (holdings: Map<string, Holding>, roles: string[]): ConditionGroup[] => {
  const groups: ConditionGroup[] = [];
  for (const role of roles) {
    const holding = holdings.get(role);
    if (holding === undefined || holding === true) continue;
    const condition = holdingCondition(holding);
    const group = groups.find((g) => sameExpression(g.condition, condition));
    if (group) group.roles.push(role);
    else groups.push({ roles: [role], condition });
  }
  return groups;
};

export const projectFilamentPermissions = (
  doc: IrDocument,
  roles: Role[],
  options: ProjectionOptions = {},
): FilamentPermissions => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const keys = new Set<string>();
  const gaps: CapabilityGap[] = [];
  const roleGrants: { role: string; keys: string[] }[] = [];
  // Per `<type>.<action>`, how each role holds it.
  const holdings = new Map<string, Map<string, Holding>>();
  const readConditions = new Map<string, Expression>();
  const adminRoles = new Set(roles.filter((r) => r.admin === true).map((r) => r.name));
  const assigns = new Map<string, Set<string>>();
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
        // The creator is an admin account, so only an admin role's condition may compare it
        // with the caller.
        const creator = options.creators === true && role.admin === true ? [CREATED_BY] : [];
        const allowed = new Set<string>([...USER_CONTEXT, ...recordVars(ct), ...creator]);
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
        const ca = `${grant.contentType}.${action}`;
        const byRole = holdings.get(ca) ?? holdings.set(ca, new Map()).get(ca)!;
        const held = byRole.get(role.name);
        if (!grant.condition) byRole.set(role.name, true);
        else if (held === undefined) byRole.set(role.name, [grant.condition]);
        else if (held !== true && !held.some((c) => sameExpression(c, grant.condition!)))
          held.push(grant.condition);
        // The content API's list scope takes one condition for every caller: the first a role
        // of its users reads under. An admin account never calls the content API.
        if (action === "read" && grant.condition && !adminRoles.has(role.name)) {
          const existing = readConditions.get(grant.contentType);
          if (existing && !sameExpression(existing, grant.condition)) {
            gaps.push({
              feature: "conditionConflict",
              location: { contentType: grant.contentType, rule: role.name },
              severity: "downgrade",
              message: `roles read "${grant.contentType}" under different conditions; the content API's list keeps to the first`,
            });
          } else if (!existing) {
            readConditions.set(grant.contentType, grant.condition);
          }
        }
      }
      if (grant.assign) {
        const cur = assigns.get(grant.contentType) ?? new Set<string>();
        Object.keys(grant.assign).forEach((k) => cur.add(k));
        assigns.set(grant.contentType, cur);
      }
    }
    roleGrants.push({ role: role.name, keys: [...roleKeys].sort() });
  }

  const rolesByKey = new Map<string, string[]>();
  for (const { role, keys } of roleGrants) {
    for (const key of keys) rolesByKey.set(key, [...(rolesByKey.get(key) ?? []), role]);
  }

  // Every type gets every action's method, held by no role where none grants it: Filament allows
  // what a policy has no method for, so a missing method would open the admin to every user.
  const policyTypes = doc.contentTypes.filter((ct) => actionsByCt.has(ct.name) || !ct.builtin);
  const policies: PolicySpec[] = policyTypes
    .map((ct): [string, string[]] => [
      ct.name,
      ["create", "delete", "read", "update", ...(ct.options?.draftPublish ? ["publish"] : [])],
    ])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ctName, actions]): PolicySpec => {
      const methods: PolicyMethodSpec[] = [];
      for (const action of [...actions].sort()) {
        const key = permissionKey(ctName, action as never);
        const holders = [...(rolesByKey.get(key) ?? [])].sort();
        const groups = conditionGroups(holdings.get(`${ctName}.${action}`) ?? new Map(), holders);
        for (const pm of POLICY_METHODS[action as keyof typeof POLICY_METHODS]) {
          // Record-scoped conditions govern access to a record; methods without a $record
          // (create, viewAny) cannot evaluate them and must not fail closed on their absence.
          const conditions = pm.record && groups.length > 0 ? groups : undefined;
          methods.push({
            method: pm.method,
            key,
            record: pm.record,
            roles: holders,
            ...(conditions ? { conditions } : {}),
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
    readConditions,
    adminReadScopes: adminReadScopes(holdings, adminRoles),
    assigns: new Map([...assigns.entries()].map(([ct, s]) => [ct, [...s].sort()])),
    gaps,
  };
};

/** Per type some admin role reads under a condition, the admin roles reading it and how. */
const adminReadScopes = (
  holdings: Map<string, Map<string, Holding>>,
  adminRoles: Set<string>,
): Map<string, AdminReadScope> => {
  const scopes = new Map<string, AdminReadScope>();
  for (const [ca, byRole] of [...holdings].sort(([a], [b]) => a.localeCompare(b))) {
    if (!ca.endsWith(".read")) continue;
    const readers = [...byRole.keys()].filter((r) => adminRoles.has(r)).sort();
    const conditions = conditionGroups(byRole, readers);
    if (conditions.length === 0) continue;
    scopes.set(ca.slice(0, -".read".length), {
      unconditional: readers.filter((r) => byRole.get(r) === true),
      conditions,
    });
  }
  return scopes;
};
