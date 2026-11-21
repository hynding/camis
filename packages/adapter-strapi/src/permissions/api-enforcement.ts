import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import {
  fieldApiName,
  type CapabilityGap,
  type ContentType,
  type IrDocument,
} from "@camis/ir-schema";
import {
  recordVariables,
  toRecordFilter,
  USER_VARIABLES,
  type Action,
  type RecordFilter,
  type Role,
} from "@camis/permissions";
import { strapiNames } from "@camis/strapi-schema";
import { CORE_ACTIONS } from "../hooks/route-hooks";
import { projectReach, typeKey } from "./api-reach";
import { projectRelationWrites, relationWriteGaps } from "./api-relation-writes";
import { conditionName } from "./condition-name";

/** The actions the content API serves an entry through, which a condition may narrow. */
const ENFORCED_ACTIONS = ["read", "create", "update", "delete"] as const;
type EnforcedAction = (typeof ENFORCED_ACTIONS)[number];

export interface ApiCondition {
  name: string;
  predicate: Expression;
  /** The condition as a row filter, for a list; null when it has none. */
  filter: RecordFilter | null;
}

/** Outright, or under the named conditions (any of them). */
export type ApiHolding = true | string[];

export type ApiRoleRules = Partial<Record<EnforcedAction, ApiHolding>> & {
  /** The Strapi attributes the role's grants assign from the session user. */
  assign: string[];
};

export interface ApiTypeRules {
  contentType: string;
  uid: string;
  /** The type has grants a condition or assign touches; otherwise it is served for its reach. */
  own: boolean;
  /** The type's conditions, each with its row filter compiled for the type's own fields. */
  conditions: ApiCondition[];
  /** The defaults Strapi fills for an omitted field, by the record variable reading it. */
  defaults: Record<string, string | number | boolean>;
  /** The relation attributes whose writes change another entry the controllers guard. */
  relations: Record<string, ApiRelationWrite>;
  /** Each record variable the type's conditions read, as the Strapi attribute holding it. */
  variables: Record<string, { field: string; relation: boolean }>;
  /** Core actions the router opens with `auth: false`. */
  open: string[];
  /** Every attribute a grant on the type assigns. */
  assign: string[];
  admins: string[];
  roles: Record<string, ApiRoleRules>;
}

/** How a holder's attribute leads towards a conditioned type. */
export type ApiHolderLink =
  | { relation: string }
  | { component: string }
  | { zone: string[] }
  /** A media field: the file's `related` entries reach every type a file can be attached to. */
  | { media: true };

/** What a write through a relation attribute changes besides the entry written. */
export interface ApiRelationWrite {
  target: string;
  /** Both sides declare the link, so it shows on the entry at the other end too. */
  mirrored: boolean;
  /** This side holds one entry at most: a write replaces its last link. */
  toOne: boolean;
  /** The other side holds one entry at most: linking it takes it from its last holder. */
  exclusive: boolean;
}

/** A content type or component that reaches a conditioned type, by its Strapi uid. */
export interface ApiHolder {
  /** Every attribute `populate=*` populates. */
  populatable: string[];
  links: Record<string, ApiHolderLink>;
}

export interface ApiEnforcement {
  types: ApiTypeRules[];
  holders: Record<string, ApiHolder>;
  gaps: CapabilityGap[];
}

const USER_NAMES = Object.keys(USER_VARIABLES);
const ROW_VARIABLES =
  "only eq/and/or over record.<field> or record.<relation>Id against a literal or user.id/email/role";
const ENTRY_VARIABLES =
  "only user.id/email/role, record.<field> and record.<relation>Id of an owning relation";

const VERB: Record<Exclude<EnforcedAction, "read">, string> = {
  create: "create",
  update: "update",
  delete: "delete",
};

const BUILTIN_PLUGIN: Record<string, string> = { user: "users-permissions", file: "upload" };

const restricts = (role: Role): boolean => role.admin !== true;
const touches = (grant: Role["grants"][number]): boolean =>
  grant.condition !== undefined || Object.keys(grant.assign ?? {}).length > 0;

/** The record variables of `ct`, keyed as Ring 1 names them, valued as Strapi stores them. */
const strapiVariables = (ct: ContentType) => {
  const apiName = new Map(ct.fields.map((f) => [f.name, fieldApiName(f)]));
  const variables = recordVariables(ct);
  return {
    typeOf: (name: string) => variables.get(name)?.type,
    attribute: (name: string) => {
      const v = variables.get(name);
      return v === undefined
        ? undefined
        : { field: apiName.get(v.field) ?? v.field, relation: v.relation };
    },
    apiName: (field: string) => apiName.get(field) ?? field,
  };
};

const gap = (
  ct: string,
  role: string,
  severity: CapabilityGap["severity"],
  message: string,
  feature = "apiGrantCondition",
): CapabilityGap => ({ feature, location: { contentType: ct, rule: role }, severity, message });

/**
 * Why the content API cannot enforce `condition` for `action`, or undefined when it can: a list
 * needs a row filter; an entry needs only variables a stored row has; a create, variables known
 * before the write (fields as sent, relations the server assigns).
 */
const unenforceable = (
  ct: ContentType,
  role: string,
  action: EnforcedAction,
  condition: Expression,
  assigned: ReadonlySet<string>,
): string | undefined => {
  const vars = strapiVariables(ct);
  if (action === "read") {
    return toRecordFilter(condition, vars.typeOf, USER_NAMES) === null
      ? `role "${role}" reads "${ct.name}" under a condition the Strapi content API cannot filter a list by (${ROW_VARIABLES}); every row would be listed`
      : undefined;
  }
  const records = recordVariables(ct);
  const unknown = freeVars(condition).filter((v) => !USER_NAMES.includes(v) && !records.has(v));
  if (unknown.length > 0) {
    return `role "${role}" may ${VERB[action]} "${ct.name}" under a condition that reads ${unknown.join(", ")}, which the Strapi content API cannot read off an entry (${ENTRY_VARIABLES})`;
  }
  if (action !== "create") return undefined;
  const unwritten = freeVars(condition).filter((v) => {
    const variable = records.get(v);
    return variable?.relation === true && !assigned.has(variable.field);
  });
  return unwritten.length > 0
    ? `role "${role}" may create "${ct.name}" under a condition that reads ${unwritten.join(", ")}, which the Strapi content API cannot know before the entry is written (assign the relation from user.id, or condition on fields only)`
    : undefined;
};

const addHolding = (
  holdings: Map<EnforcedAction, ApiHolding>,
  action: EnforcedAction,
  name: string | undefined,
): void => {
  const held = holdings.get(action);
  if (name === undefined) holdings.set(action, true);
  else if (held === undefined) holdings.set(action, [name]);
  else if (held !== true && !held.includes(name)) held.push(name);
};

/**
 * What the generated content API controllers enforce: for each collection type a non-admin role
 * holds under a condition or an assign, how every role holds each action on it, the record
 * variables its conditions read and the fields its grants assign. A condition the content API
 * cannot enforce is an error, since the action alone would open every row.
 */
export const projectApiEnforcement = (doc: IrDocument, roles: Role[]): ApiEnforcement => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const gaps: CapabilityGap[] = [];
  const admins = roles
    .filter((r) => !restricts(r))
    .map((r) => r.name)
    .sort();

  const enforced = new Set<string>();
  for (const role of roles) {
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType);
      if (ct === undefined) continue;
      if (!restricts(role) && grant.condition !== undefined)
        gaps.push(
          gap(
            ct.name,
            role.name,
            "downgrade",
            `"${role.name}" is an admin role, which the content API does not restrict: its condition on "${ct.name}" applies to the admin panel only`,
          ),
        );
      // An admin role is not restricted, but what it assigns is still the server's to fill.
      if (restricts(role) ? !touches(grant) : Object.keys(grant.assign ?? {}).length === 0)
        continue;
      if (ct.builtin !== undefined) {
        if (grant.condition !== undefined && restricts(role))
          gaps.push(
            gap(
              ct.name,
              role.name,
              "error",
              `role "${role.name}" holds "${ct.name}" under a condition, which the ${BUILTIN_PLUGIN[ct.builtin] ?? ct.builtin} plugin serves unconditioned; the Strapi target cannot enforce it`,
            ),
          );
        continue;
      }
      if (ct.kind === "single") {
        gaps.push(
          gap(
            ct.name,
            role.name,
            "error",
            `role "${role.name}" holds single type "${ct.name}" under a condition or assign, which the Strapi target does not enforce on a single type`,
          ),
        );
        continue;
      }
      enforced.add(ct.name);
    }
  }

  const types: ApiTypeRules[] = [];
  for (const ct of doc.contentTypes.filter((c) => enforced.has(c.name))) {
    const vars = strapiVariables(ct);
    const conditions = new Map<string, ApiCondition>();
    const ruleSet: Record<string, ApiRoleRules> = {};
    const read = new Set<string>();
    const typeAssign = new Set<string>();
    for (const role of roles) {
      const grants = role.grants.filter((g) => g.contentType === ct.name);
      if (grants.length === 0) continue;
      const assigned = new Set(grants.flatMap((g) => Object.keys(g.assign ?? {})));
      const holdings = new Map<EnforcedAction, ApiHolding>();
      for (const grant of grants) {
        const name = grant.condition === undefined ? undefined : conditionName(grant.condition);
        for (const action of ENFORCED_ACTIONS.filter((a) => grant.actions.includes(a as Action))) {
          if (grant.condition !== undefined && restricts(role)) {
            const why = unenforceable(ct, role.name, action, grant.condition, assigned);
            if (why !== undefined) gaps.push(gap(ct.name, role.name, "error", why));
            conditions.set(name!, {
              name: name!,
              predicate: grant.condition,
              filter: toRecordFilter(grant.condition, vars.typeOf, USER_NAMES),
            });
            for (const v of freeVars(grant.condition)) {
              if (vars.attribute(v) !== undefined) read.add(v);
            }
          }
          addHolding(holdings, action, restricts(role) ? name : undefined);
        }
      }
      const assign = [...assigned].map(vars.apiName).sort();
      assign.forEach((a) => typeAssign.add(a));
      ruleSet[role.name] = {
        ...Object.fromEntries(
          ENFORCED_ACTIONS.filter((a) => holdings.has(a)).map((a) => [a, holdings.get(a)!]),
        ),
        assign,
      };
    }
    const core = CORE_ACTIONS.collection;
    const variables = [...read].sort();
    types.push({
      contentType: ct.name,
      uid: strapiNames(ct).uid,
      own: true,
      conditions: [...conditions.values()].sort((a, b) => a.name.localeCompare(b.name)),
      defaults: defaultsOf(ct, variables),
      relations: {},
      variables: Object.fromEntries(variables.map((v) => [v, vars.attribute(v)!] as const)),
      open: (ct.options?.publicApiActions ?? [])
        .map((a) => core[a])
        .filter((a): a is string => a !== undefined),
      assign: [...typeAssign].sort(),
      admins,
      roles: ruleSet,
    });
  }

  const reach = projectReach(doc, roles, types);
  gaps.push(...reach.gaps, ...relationWriteGaps(doc, roles, types));
  const writes = projectRelationWrites(doc, enforced);
  const core = CORE_ACTIONS.collection;
  const openOf = (ct: ContentType): string[] =>
    (ct.options?.publicApiActions ?? [])
      .map((a) => core[a])
      .filter((a): a is string => a !== undefined);
  const served = doc.contentTypes.filter(
    (ct) =>
      enforced.has(ct.name) ||
      (ct.kind === "collection" &&
        ct.builtin === undefined &&
        (reach.reaching.has(typeKey(ct)) || writes.has(ct.name))),
  );
  return {
    types: served.map((ct): ApiTypeRules => {
      const relations = writes.get(ct.name) ?? {};
      const own = types.find((t) => t.contentType === ct.name);
      return own !== undefined
        ? { ...own, relations }
        : {
            contentType: ct.name,
            uid: strapiNames(ct).uid,
            own: false,
            conditions: [],
            defaults: {},
            relations,
            variables: {},
            open: openOf(ct),
            assign: [],
            admins,
            roles: {},
          };
    }),
    holders: reach.holders,
    gaps,
  };
};

/** The defaults of the scalar fields the conditions read, which Strapi fills on create. */
const defaultsOf = (
  ct: ContentType,
  variables: readonly string[],
): Record<string, string | number | boolean> => {
  const records = recordVariables(ct);
  const defaults: Record<string, string | number | boolean> = {};
  for (const name of variables) {
    const variable = records.get(name);
    if (variable === undefined || variable.relation) continue;
    const f = ct.fields.find((g) => g.name === variable.field);
    const value = f !== undefined && "default" in f ? f.default : undefined;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      defaults[name] = value;
  }
  return defaults;
};
