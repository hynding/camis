import type { Value } from "@camis/expr";

// The content API's row-level decisions, copied into each generated Strapi project below the
// Ring 1 runtime as src/permissions/api-conditions.ts, then followed by the project's own rules.
// Pure: nothing here touches Strapi, so every decision is testable on its own.

export type RecordData = Record<string, Value>;

export type ConditionFilter =
  | {
      kind: "eq";
      variable: string;
      value: { kind: "literal"; value: Value } | { kind: "user"; variable: string };
    }
  /** A part that reads only the caller: Ring 1 decides it once per request. */
  | { kind: "caller"; test: (data: RecordData) => boolean }
  | { kind: "and" | "or"; args: ConditionFilter[] };

export interface Condition {
  /** Ring 1: whether the condition holds for a record and its caller; an error denies. */
  test: (data: RecordData) => boolean;
  /** The same condition as a filter over rows; null when it has none (then no list uses it). */
  filter: ConditionFilter | null;
}

/** A role holds an action outright, or only where one of its conditions holds. */
export type Holding = true | readonly Condition[];

export interface RoleRules {
  read?: Holding;
  create?: Holding;
  update?: Holding;
  delete?: Holding;
  /** Fields the server fills from the session user: a client never writes them. */
  assign: readonly string[];
}

export interface RecordVariable {
  field: string;
  /** `record.<relation>Id`: the id of the entry an owning relation points at. */
  relation: boolean;
}

export interface TypeRules {
  /** The record variables the type's conditions read. */
  variables: Readonly<Record<string, RecordVariable>>;
  /** Core actions the router opens with `auth: false`: Strapi asks no role there. */
  open: readonly string[];
  /** Every field a grant on the type assigns, for callers that hold no role. */
  assign: readonly string[];
  /** Roles flagged admin, which no condition restricts. */
  admins: readonly string[];
  roles: Readonly<Record<string, RoleRules>>;
}

export interface SessionUser {
  id: Value;
  documentId: string | null;
  email: Value;
  role: string;
}

export type Caller =
  | { kind: "unrestricted"; user: SessionUser | null; assign: readonly string[] }
  | {
      kind: "role";
      role: string;
      user: SessionUser | null;
      rules: RoleRules | null;
      assign: readonly string[];
    }
  | { kind: "refused" };

export type RecordAction = "read" | "update" | "delete";
export type Verdict = "allow" | "notFound" | "forbidden";

/** users-permissions' role for a request that carries no session. */
const GUEST_ROLE = "public";
/** A filter no row satisfies: every entry has an id. */
const NO_ROWS: Record<string, unknown> = { id: { $null: true } };

const field = (source: unknown, key: string): unknown =>
  typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;

/** A stored value as Ring 1 sees it: a date as its ISO string, anything without a form as null. */
const asValue = (raw: unknown): Value => {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  if (raw instanceof Date) return raw.toISOString();
  return null;
};

const strategyOf = (state: unknown): unknown =>
  field(field(field(state, "auth"), "strategy"), "name");

/**
 * Who is asking, from Strapi's ctx.state. A route opened with `auth: false` and an API token
 * (which stands for no role and no user) read every row, as Strapi's own do; a session acts as
 * its users-permissions role, an admin role unrestricted; a request with no session acts as the
 * public role. Anything else — a session whose role was not loaded, an unknown strategy — is
 * refused rather than guessed at.
 */
export const callerOf = (rules: TypeRules, state: unknown, action: string): Caller => {
  if (rules.open.includes(action))
    return { kind: "unrestricted", user: null, assign: rules.assign };
  if (strategyOf(state) === "api-token")
    return { kind: "unrestricted", user: null, assign: rules.assign };
  const sessionUser = field(state, "user");
  if (sessionUser !== undefined && sessionUser !== null) {
    const role = field(field(sessionUser, "role"), "type");
    if (typeof role !== "string") return { kind: "refused" };
    const documentId = field(sessionUser, "documentId");
    const user: SessionUser = {
      id: asValue(field(sessionUser, "id")),
      documentId: typeof documentId === "string" ? documentId : null,
      email: asValue(field(sessionUser, "email")),
      role,
    };
    const roleRules = rules.roles[role] ?? null;
    const assign = roleRules?.assign ?? [];
    if (rules.admins.includes(role)) return { kind: "unrestricted", user, assign };
    return { kind: "role", role, user, rules: roleRules, assign };
  }
  if (strategyOf(state) === "users-permissions") {
    const roleRules = rules.roles[GUEST_ROLE] ?? null;
    return {
      kind: "role",
      role: GUEST_ROLE,
      user: null,
      rules: roleRules,
      assign: roleRules?.assign ?? [],
    };
  }
  return { kind: "refused" };
};

/** The caller's user variables; none for a guest, so a condition naming one denies. */
const userData = (user: SessionUser | null): RecordData =>
  user === null ? {} : { "user.id": user.id, "user.email": user.email, "user.role": user.role };

/** The record variables of one stored row (as loaded by `recordQuery`). */
export const recordData = (rules: TypeRules, row: unknown): RecordData => {
  const data: RecordData = {};
  for (const [name, variable] of Object.entries(rules.variables)) {
    const raw = field(row, variable.field);
    data[name] = variable.relation ? asValue(field(raw, "id") ?? null) : asValue(raw);
  }
  return data;
};

const holds = (holding: Holding, data: RecordData): boolean =>
  holding === true || holding.some((condition) => condition.test(data));

const strapiFilter = (
  node: ConditionFilter,
  rules: TypeRules,
  user: SessionUser | null,
): Record<string, unknown> | boolean => {
  if (node.kind === "caller") return node.test(userData(user));
  if (node.kind === "eq") {
    let value: Value;
    if (node.value.kind === "user") {
      // A guest has no user value; Ring 1 denies the comparison, so it matches no row.
      if (user === null) return false;
      value = userData(user)[node.value.variable] ?? null;
    } else value = node.value.value;
    const variable = rules.variables[node.variable];
    if (variable === undefined) return false;
    const test = value === null ? { $null: true } : { $eq: value };
    return { [variable.field]: variable.relation ? { id: test } : test };
  }
  const args = node.args.map((a) => strapiFilter(a, rules, user));
  const absorbing = node.kind === "or";
  if (args.includes(absorbing)) return absorbing;
  const rest = args.filter((a): a is Record<string, unknown> => typeof a !== "boolean");
  if (rest.length === 0) return !absorbing;
  return rest.length === 1 ? rest[0]! : { [node.kind === "and" ? "$and" : "$or"]: rest };
};

/**
 * The filter that narrows a list to the rows the caller may read, or null when nothing narrows
 * it. A role reading under several conditions reads the rows any of them lets through.
 */
export const listFilter = (rules: TypeRules, caller: Caller): Record<string, unknown> | null => {
  if (caller.kind === "unrestricted") return null;
  if (caller.kind === "refused") return NO_ROWS;
  const holding = caller.rules?.read;
  if (holding === undefined) return NO_ROWS;
  if (holding === true) return null;
  const branches: ConditionFilter[] = [];
  for (const condition of holding) {
    // Generation refuses a read condition with no filter; should one arrive, it lists nothing.
    if (condition.filter === null) return NO_ROWS;
    branches.push(condition.filter);
  }
  const filter = strapiFilter({ kind: "or", args: branches }, rules, caller.user);
  if (filter === true) return null;
  return filter === false ? NO_ROWS : filter;
};

/** The client's filters, narrowed by the scope: `$and`, so no filter of the client's can widen it. */
export const scopedFilters = (
  clientFilters: unknown,
  scope: Record<string, unknown>,
): Record<string, unknown> => {
  const empty =
    clientFilters === undefined ||
    clientFilters === null ||
    (typeof clientFilters === "object" && Object.keys(clientFilters).length === 0);
  return empty ? scope : { $and: [clientFilters, scope] };
};

/** What to load of an entry's rows (every version and locale) to decide on it. */
export const recordQuery = (rules: TypeRules, documentId: string): Record<string, unknown> => {
  const variables = Object.values(rules.variables);
  const scalars = variables.filter((v) => !v.relation).map((v) => v.field);
  const relations = variables.filter((v) => v.relation).map((v) => v.field);
  return {
    where: { documentId },
    select: ["id", ...scalars],
    ...(relations.length > 0
      ? { populate: Object.fromEntries(relations.map((r) => [r, { select: ["id"] }])) }
      : {}),
  };
};

/**
 * Whether the caller may act on an entry, given every row it has. An entry the caller may not
 * read is not found, as on a list; one it may read but not change is forbidden. Every row must
 * pass, so no version or locale of an entry slips through on another's account.
 */
export const recordVerdict = (
  rules: TypeRules,
  caller: Caller,
  action: RecordAction,
  rows: readonly unknown[],
): Verdict => {
  if (caller.kind === "unrestricted") return "allow";
  if (caller.kind === "refused") return "forbidden";
  if (rows.length === 0) return "notFound";
  const user = userData(caller.user);
  const data = rows.map((row) => ({ ...recordData(rules, row), ...user }));
  const read = caller.rules?.read;
  if (action === "read") {
    return read !== undefined && data.every((d) => holds(read, d)) ? "allow" : "notFound";
  }
  if (read !== undefined && !data.every((d) => holds(read, d))) return "notFound";
  const holding = caller.rules?.[action];
  return holding !== undefined && data.every((d) => holds(holding, d)) ? "allow" : "forbidden";
};

/**
 * Whether the caller may create an entry from `data` (assigned fields already removed): its
 * fields as sent, and each assigned relation as the caller's own id.
 */
export const createVerdict = (
  rules: TypeRules,
  caller: Caller,
  data: unknown,
): "allow" | "forbidden" => {
  if (caller.kind === "unrestricted") return "allow";
  if (caller.kind === "refused") return "forbidden";
  const holding = caller.rules?.create;
  if (holding === undefined) return "forbidden";
  if (holding === true) return "allow";
  const record: RecordData = {};
  for (const [name, variable] of Object.entries(rules.variables)) {
    record[name] = variable.relation
      ? caller.assign.includes(variable.field)
        ? (caller.user?.id ?? null)
        : null
      : asValue(field(data, variable.field) ?? null);
  }
  return holds(holding, { ...record, ...userData(caller.user) }) ? "allow" : "forbidden";
};

/** The request's data without the fields the server assigns, so a client can neither set nor move them. */
export const withoutAssigned = (
  caller: Caller,
  data: Record<string, unknown>,
): Record<string, unknown> => {
  if (caller.kind === "refused") return data;
  return Object.fromEntries(Object.entries(data).filter(([key]) => !caller.assign.includes(key)));
};

/** Each assigned relation set to the session user; left unset when there is none. */
export const assignedValues = (caller: Caller): Record<string, unknown> => {
  if (caller.kind === "refused" || caller.user === null || caller.user.documentId === null)
    return {};
  const documentId = caller.user.documentId;
  return Object.fromEntries(caller.assign.map((f) => [f, { set: [{ documentId }] }]));
};
