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

/** What a write through a relation attribute changes besides the entry written. */
export interface RelationWrite {
  target: string;
  /** Both sides declare the link, so it shows on the entry at the other end too. */
  mirrored: boolean;
  /** This side holds one entry at most: a write replaces its last link. */
  toOne: boolean;
  /** The other side holds one entry at most: linking it takes it from its last holder. */
  exclusive: boolean;
}

export interface TypeRules {
  /** The type has rules of its own; otherwise it is served only for what it reaches. */
  own: boolean;
  /** Field defaults Strapi fills on create when a field is omitted, by record variable. */
  defaults: Readonly<Record<string, Value>>;
  /** The relation attributes whose writes change another entry the rules guard. */
  relations: Readonly<Record<string, RelationWrite>>;
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

/**
 * How a type or component reaches a conditioned type: a relation, a component, a zone, or a media
 * field (whose file's `related` entries are every entry the file is attached to).
 */
export type HolderLink =
  | { relation: string }
  | { component: string }
  | { zone: readonly string[] }
  | { media: true };

export interface Holder {
  /** Every attribute `populate=*` populates. */
  populatable: readonly string[];
  /** The attributes that lead to a conditioned type, directly or further on. */
  links: Readonly<Record<string, HolderLink>>;
}

/** The project's rules per type uid, and the holders (types and components) that reach. */
export interface Tables {
  rules: Readonly<Record<string, TypeRules>>;
  holders: Readonly<Record<string, Holder>>;
}

/** A result or why there is none; both sides name both fields, so either reads without narrowing. */
export type Checked<T> =
  | { ok: true; value: T; message?: undefined }
  | { ok: false; value?: undefined; message: string };

/** The entries of a conditioned type a write links, by document id or row id. */
export interface RelationRef {
  target: string;
  documentIds: string[];
  ids: number[];
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
/** A request users-permissions authenticated with no session: the public role's. */
const GUEST_STATE = { auth: { strategy: { name: "users-permissions" } } };
/**
 * A filter no row satisfies, not even the all-NULL row a LEFT JOIN gives an entry with no link:
 * `id IS NULL` alone would match that one.
 */
const NO_ROWS: Record<string, unknown> = {
  $and: [{ id: { $null: true } }, { id: { $notNull: true } }],
};
/**
 * Beside a scope on a joined relation: Strapi LEFT JOINs a filtered relation, so an entry with no
 * link joins an all-NULL row, which a scope may satisfy (`owner IS NULL`) as may the client's own
 * filter (`title IS NULL`); "none" and "one you cannot read" must answer alike.
 */
const LINKED: Record<string, unknown> = { id: { $notNull: true } };

const field = (source: unknown, key: string): unknown =>
  typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;

/**
 * A table's own entry for a key a caller chose (a role name, an attribute name), never one
 * inherited from Object.prototype: a role named "constructor" names no rules.
 */
const own = <T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  table !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    const roleRules = own(rules.roles, role) ?? null;
    // A role the rules do not name keeps no field of the type's assigned ones either.
    const assign = roleRules?.assign ?? rules.assign;
    if (rules.admins.includes(role)) return { kind: "unrestricted", user, assign };
    return { kind: "role", role, user, rules: roleRules, assign };
  }
  if (strategyOf(state) === "users-permissions") {
    const roleRules = own(rules.roles, GUEST_ROLE) ?? null;
    return {
      kind: "role",
      role: GUEST_ROLE,
      user: null,
      rules: roleRules,
      assign: roleRules?.assign ?? rules.assign,
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
  if (caller.kind === "unrestricted" || !rules.own) return null;
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
  if (caller.kind === "unrestricted" || !rules.own) return "allow";
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

/** A field as a create sends it, or the default Strapi fills when it is omitted. */
const sentOrDefault = (rules: TypeRules, name: string, data: unknown, key: string): Value => {
  const sent = isRecord(data) ? own(data, key) : undefined;
  if (sent !== undefined) return asValue(sent);
  return own(rules.defaults, name) ?? null;
};

/**
 * Whether the caller may create an entry from `data` (assigned fields already removed): its
 * fields as sent (an omitted one as its default), and each assigned relation as the caller's id.
 */
export const createVerdict = (
  rules: TypeRules,
  caller: Caller,
  data: unknown,
): "allow" | "forbidden" => {
  if (caller.kind === "unrestricted" || !rules.own) return "allow";
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
      : sentOrDefault(rules, name, data, variable.field);
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

/** The caller as a type it reaches sees it: no route of that type is open to it here. */
const reachCaller = (tables: Tables, uid: string, state: unknown): Caller | undefined => {
  const rules = own(tables.rules, uid);
  return rules === undefined || !rules.own ? undefined : callerOf(rules, state, "");
};

/** The filter a populate or a relation filter into `uid` carries for the caller; null: none. */
const reachScope = (
  tables: Tables,
  uid: string,
  state: unknown,
): Record<string, unknown> | null => {
  const caller = reachCaller(tables, uid, state);
  return caller === undefined ? null : listFilter(own(tables.rules, uid)!, caller);
};

const both = (
  a: unknown,
  scope: Record<string, unknown> | null,
): Record<string, unknown> | undefined => {
  const present = a !== undefined && a !== null && !(isRecord(a) && Object.keys(a).length === 0);
  if (scope === null) return present ? (a as Record<string, unknown>) : undefined;
  return present ? { $and: [a, scope] } : scope;
};

/** A populate in any of Strapi's forms as `{ attribute: true | options }`. */
const normalisePopulate = (
  tables: Tables,
  holder: string,
  populate: unknown,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const add = (path: string[], entry: unknown): void => {
    const [head, ...rest] = path;
    if (head === undefined || head === "") return;
    if (rest.length === 0) {
      out[head] = merge(own(out, head), entry);
      return;
    }
    const existing = own(out, head);
    const options = isRecord(existing) ? existing : {};
    out[head] = { ...options, populate: merge(options.populate, toPaths(rest)) };
  };
  const toPaths = (path: string[]): Record<string, unknown> =>
    path.length === 1 ? { [path[0]!]: true } : { [path[0]!]: { populate: toPaths(path.slice(1)) } };
  const fromString = (text: string): void => {
    for (const part of text.split(",")) {
      const trimmed = part.trim();
      if (trimmed === "*") {
        for (const attribute of own(tables.holders, holder)?.populatable ?? [])
          add([attribute], true);
      } else add(trimmed.split("."), true);
    }
  };
  if (populate === true) fromString("*");
  else if (typeof populate === "string") fromString(populate);
  else if (Array.isArray(populate)) {
    for (const item of populate) if (typeof item === "string") fromString(item);
  } else if (isRecord(populate)) {
    for (const [key, entry] of Object.entries(populate)) {
      if (entry === false) continue;
      add([key], entry === "*" ? true : entry);
    }
  }
  return out;
};

/** Two populate entries for one attribute as one: options merged, nested populates merged. */
const merge = (a: unknown, b: unknown): unknown => {
  if (a === undefined || a === true)
    return b === undefined ? a : b === true && a === true ? true : b;
  if (b === undefined || b === true) return a;
  if (isRecord(a) && isRecord(b)) {
    const merged: Record<string, unknown> = { ...a, ...b };
    if (a.populate !== undefined && b.populate !== undefined)
      merged.populate = { ...asObject(a.populate), ...asObject(b.populate) };
    return merged;
  }
  return b;
};
const asObject = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : { "*": value };

/** The paths a sort names, each as its attribute segments. */
const sortPaths = (sort: unknown): string[][] => {
  if (typeof sort === "string")
    return sort
      .split(",")
      .map((s) => s.trim().split(":")[0]!.split("."))
      .filter((p) => p[0] !== "");
  if (Array.isArray(sort)) return sort.flatMap(sortPaths);
  if (isRecord(sort))
    return Object.entries(sort).flatMap(([key, value]) =>
      isRecord(value) ? sortPaths(value).map((p) => [key, ...p]) : [[key]],
    );
  return [];
};

/** Whether a sort path crosses a relation into a type the caller reads under a condition. */
const sortLeaks = (tables: Tables, holder: string, path: string[], state: unknown): boolean => {
  const [head, ...rest] = path;
  if (head === undefined || rest.length === 0) return false;
  const link = own(own(tables.holders, holder)?.links, head);
  if (link === undefined) return false;
  if ("relation" in link) {
    if (reachScope(tables, link.relation, state) !== null) return true;
    return sortLeaks(tables, link.relation, rest, state);
  }
  if ("component" in link) return sortLeaks(tables, link.component, rest, state);
  return false;
};

const refuse = (message: string): { ok: false; message: string } => ({ ok: false, message });

/**
 * A filter with every relation into a conditioned type narrowed to the rows the caller reads.
 * Each relation or component filter becomes its own item of an `$and` at its level, with the
 * scope beside the client's filter on that same relation (so both share its join): Strapi merges
 * a relation's processed where into its parent with Object.assign, so two of them side by side,
 * or one beside the client's own `$and`, would otherwise overwrite each other.
 *
 * Under a client's `$not` (`negated`) a relation into a conditioned type is refused: SQL's NOT of
 * an unknown is unknown, so a row whose scope reads a NULL (an entry with no owner) would drop out
 * of a right guess and stay in a wrong one. Everywhere else the scope sits in a positive `$and`
 * (a client's `$or`, `$ne`, `$notIn` or `$null` included), where an unknown never matches.
 */
const scopeFilters = (
  tables: Tables,
  holder: string,
  filters: unknown,
  state: unknown,
  negated = false,
): Checked<unknown> => {
  if (Array.isArray(filters)) {
    const items: unknown[] = [];
    for (const item of filters) {
      const scoped = scopeFilters(tables, holder, item, state, negated);
      if (!scoped.ok) return scoped;
      items.push(scoped.value);
    }
    return { ok: true, value: items };
  }
  if (!isRecord(filters)) return { ok: true, value: filters };
  const rest: Record<string, unknown> = {};
  const lifted: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(filters)) {
    const link = key.startsWith("$") ? undefined : own(own(tables.holders, holder)?.links, key);
    let scoped: Checked<unknown> = { ok: true, value };
    if (key === "$and" || key === "$or" || key === "$not") {
      scoped = scopeFilters(tables, holder, value, state, negated || key === "$not");
    } else if (link !== undefined && "relation" in link) {
      scoped = relationFilter(tables, link.relation, key, value, state, negated);
    } else if (link !== undefined && "component" in link) {
      scoped = scopeFilters(tables, link.component, value, state, negated);
    }
    if (!scoped.ok) return scoped;
    if (link !== undefined && ("relation" in link || "component" in link))
      lifted.push({ [key]: scoped.value });
    else rest[key] = scoped.value;
  }
  if (lifted.length === 0) return { ok: true, value: rest };
  return {
    ok: true,
    value: { $and: [...(Object.keys(rest).length > 0 ? [rest] : []), ...lifted] },
  };
};

/** One relation's filter, scoped to the rows of `target` the caller reads. */
const relationFilter = (
  tables: Tables,
  target: string,
  key: string,
  value: unknown,
  state: unknown,
  negated: boolean,
): Checked<unknown> => {
  const scope = reachScope(tables, target, state);
  if (negated && scope !== null) return refuse(`Invalid $not around the relation filter ${key}`);
  const client = relationTest(key, value, scope !== null);
  if (!client.ok) return client;
  const inner = scopeFilters(tables, target, client.value, state, negated);
  if (!inner.ok) return inner;
  if (scope === null) return inner;
  const present = both(inner.value, null);
  return {
    ok: true,
    value: { $and: [...(present === undefined ? [] : [present]), LINKED, scope] },
  };
};

const GROUPS = ["$and", "$or", "$not"];

/** A boolean as Strapi's parseType reads one from a query string; undefined for anything else. */
const parseBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (["true", "t", "1", 1].includes(value as string | number)) return true;
  if (["false", "f", "0", 0].includes(value as string | number)) return false;
  return undefined;
};

/**
 * A relation's filter as one on the related rows' attributes. Strapi reads a bare value, or a
 * lone operator, on the relation itself as a test of the related id; written so, it can sit
 * beside the scope. "Has none" (`$null`) across a conditioned relation is refused: it would count
 * an entry the caller cannot read as none, and only a negation could ask for "none readable".
 * `$notNull` asks for a readable entry. Either operator's value is read as Strapi's parseType reads
 * a boolean ("true", "t", "1", "false", "f", "0"); anything else is refused rather than guessed.
 */
const relationTest = (key: string, value: unknown, conditioned: boolean): Checked<unknown> => {
  if (!isRecord(value)) return { ok: true, value: { id: value } };
  const keys = Object.keys(value);
  const operators = keys.filter((k) => k.startsWith("$"));
  if (operators.length === 0) return { ok: true, value };
  if (operators.length !== keys.length || operators.length > 1)
    return refuse(`Invalid filter on the relation ${key}: one operator, or attributes`);
  const operator = operators[0]!;
  if (GROUPS.includes(operator)) return { ok: true, value };
  if (operator === "$null" || operator === "$notNull") {
    if (!conditioned) return { ok: true, value: { id: value } };
    const flag = parseBoolean(value[operator]);
    if (flag === undefined) return refuse(`Invalid ${operator} on the relation ${key}`);
    const none = operator === "$null" ? flag : !flag;
    if (none) return refuse(`Invalid $null on the relation ${key}`);
    return { ok: true, value: { id: { $notNull: true } } };
  }
  return { ok: true, value: { id: value } };
};

/** Whether a file's populate asks for its `related` entries, in any form. */
const populatesRelated = (populate: unknown): boolean => {
  const named = (text: string): boolean =>
    text.split(",").some((part) => ["related", "*"].includes(part.trim().split(".")[0]!));
  if (populate === true) return true;
  if (typeof populate === "string") return named(populate);
  if (Array.isArray(populate)) return populate.some((p) => typeof p === "string" && named(p));
  if (isRecord(populate))
    return Object.entries(populate).some(([key, entry]) => entry !== false && named(key));
  return false;
};

/** One populate entry for an attribute of `holder`, scoped; a message when it cannot be. */
const scopeEntry = (
  tables: Tables,
  link: HolderLink,
  entry: unknown,
  state: unknown,
): Checked<unknown> => {
  const options = isRecord(entry) ? entry : {};
  if ("media" in link) {
    // A file's related entries are polymorphic: no filter of one type's narrows them.
    return populatesRelated(options.populate)
      ? { ok: false, message: "Invalid populate of a file's related entries" }
      : { ok: true, value: entry };
  }
  if ("zone" in link) {
    const fragments: Record<string, unknown> = {};
    const shared = options.populate;
    const on = isRecord(options.on) ? options.on : {};
    if (shared === undefined && !isRecord(options.on)) return { ok: true, value: entry };
    for (const component of link.zone) {
      const fragment =
        own(on, component) ?? (shared === undefined ? undefined : { populate: shared });
      if (fragment === undefined) continue;
      const scoped = scopeEntry(tables, { component }, fragment, state);
      if (!scoped.ok) return { ok: false, message: scoped.message };
      fragments[component] = scoped.value;
    }
    const rest = Object.fromEntries(
      Object.entries(options).filter(([key]) => key !== "populate" && key !== "on"),
    );
    return { ok: true, value: { ...rest, on: fragments } };
  }
  const target = "relation" in link ? link.relation : link.component;
  const out: Record<string, unknown> = { ...options };
  if (options.populate !== undefined) {
    const nested = scopePopulate(tables, target, options.populate, state);
    if (!nested.ok) return { ok: false, message: nested.message };
    out.populate = nested.value;
  }
  // A component's rows are its holder's, so only its own relations take a scope; its filters and
  // sort cross them all the same.
  if (sortPaths(options.sort).some((p) => sortLeaks(tables, target, p, state)))
    return refuse("Invalid sort through a relation in populate");
  const filters =
    options.filters === undefined
      ? undefined
      : scopeFilters(tables, target, options.filters, state);
  if (filters !== undefined && !filters.ok) return filters;
  const scoped = both(
    filters?.value,
    "relation" in link ? reachScope(tables, target, state) : null,
  );
  if (scoped !== undefined) out.filters = scoped;
  return { ok: true, value: Object.keys(out).length === 0 ? true : out };
};

const scopePopulate = (
  tables: Tables,
  holder: string,
  populate: unknown,
  state: unknown,
): Checked<Record<string, unknown>> => {
  const normalised = normalisePopulate(tables, holder, populate);
  const links = own(tables.holders, holder)?.links;
  for (const [key, entry] of Object.entries(normalised)) {
    const link = own(links, key);
    if (link === undefined) continue;
    const scoped = scopeEntry(tables, link, entry, state);
    if (!scoped.ok) return { ok: false, message: scoped.message };
    normalised[key] = scoped.value;
  }
  return { ok: true, value: normalised };
};

/**
 * A sanitized query of `uid` with every relation into a conditioned type narrowed for the
 * caller: each populate of one carries that type's filter (`$and` with the client's), at any
 * depth and whatever form the populate takes; each relation filter through one is narrowed the
 * same way, a component's populate filters included, so it is no oracle; a sort through one is
 * refused, since its join carries no filter, and so is a `$not` around one or a `$null` on one.
 * A caller no role restricts gets the query back as it is.
 */
export const scopeQuery = (
  tables: Tables,
  uid: string,
  state: unknown,
  query: Record<string, unknown>,
): Checked<Record<string, unknown>> => {
  if (own(tables.holders, uid) === undefined) return { ok: true, value: query };
  const rules = own(tables.rules, uid);
  if (rules === undefined || callerOf(rules, state, "").kind === "unrestricted")
    return { ok: true, value: query };
  if (sortPaths(query.sort).some((p) => sortLeaks(tables, uid, p, state)))
    return { ok: false, message: "Invalid sort through a relation" };
  const out: Record<string, unknown> = { ...query };
  if (query.populate !== undefined) {
    const populate = scopePopulate(tables, uid, query.populate, state);
    if (!populate.ok) return { ok: false, message: populate.message };
    out.populate = populate.value;
  }
  if (query.filters !== undefined) {
    const filters = scopeFilters(tables, uid, query.filters, state);
    if (!filters.ok) return refuse(filters.message);
    out.filters = filters.value;
  }
  return { ok: true, value: out };
};

/** The entries one relation value links: document ids and row ids; null for a shape it cannot read. */
const linked = (value: unknown): { documentIds: string[]; ids: number[] } | null => {
  const documentIds: string[] = [];
  const ids: number[] = [];
  const item = (v: unknown): boolean => {
    if (typeof v === "string") documentIds.push(v);
    else if (typeof v === "number") ids.push(v);
    else if (isRecord(v) && typeof own(v, "documentId") === "string")
      documentIds.push(v.documentId as string);
    else if (isRecord(v) && typeof own(v, "id") === "number") ids.push(v.id as number);
    else return false;
    return true;
  };
  if (value === null || value === undefined) return { documentIds, ids };
  if (Array.isArray(value)) return value.every(item) ? { documentIds, ids } : null;
  if (isRecord(value) && ("connect" in value || "set" in value || "disconnect" in value)) {
    // A disconnect only drops a link, which reveals and grants nothing.
    for (const key of ["connect", "set"]) {
      const list = own(value, key);
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.every(item)) return null;
    }
    return { documentIds, ids };
  }
  return item(value) ? { documentIds, ids } : null;
};

/**
 * The entries of conditioned types a write's data links, through relations at any depth of its
 * components and zones, for those the caller reads under a condition; a message for a relation
 * value of a shape it cannot read.
 */
export const relationRefs = (
  tables: Tables,
  uid: string,
  state: unknown,
  data: Record<string, unknown>,
): Checked<RelationRef[]> => {
  const refs = new Map<string, RelationRef>();
  const walk = (holder: string, values: unknown): string | undefined => {
    if (!isRecord(values)) return undefined;
    const links = own(tables.holders, holder)?.links;
    for (const [key, value] of Object.entries(values)) {
      const link = own(links, key);
      if (link === undefined) continue;
      if ("relation" in link) {
        if (reachScope(tables, link.relation, state) === null) continue;
        const entries = linked(value);
        if (entries === null) return `Invalid relation value for ${key}`;
        if (entries.documentIds.length + entries.ids.length === 0) continue;
        const ref = refs.get(link.relation) ?? { target: link.relation, documentIds: [], ids: [] };
        ref.documentIds.push(...entries.documentIds);
        ref.ids.push(...entries.ids);
        refs.set(link.relation, ref);
      } else if ("component" in link) {
        for (const item of Array.isArray(value) ? value : [value]) {
          const problem = walk(link.component, item);
          if (problem !== undefined) return problem;
        }
      } else if ("zone" in link && Array.isArray(value)) {
        for (const item of value) {
          const component = isRecord(item) ? own(item, "__component") : undefined;
          if (typeof component !== "string" || !link.zone.includes(component)) continue;
          const problem = walk(component, item);
          if (problem !== undefined) return problem;
        }
      }
    }
    return undefined;
  };
  const problem = walk(uid, data);
  return problem === undefined
    ? { ok: true, value: [...refs.values()] }
    : { ok: false, message: problem };
};

/** What to load of the rows a write links, to decide on them. */
export const refsQuery = (tables: Tables, ref: RelationRef): Record<string, unknown> => {
  const query = recordQuery(own(tables.rules, ref.target)!, "");
  return {
    ...query,
    select: [...(query.select as string[]), "documentId"],
    where: { $or: [{ documentId: { $in: ref.documentIds } }, { id: { $in: ref.ids } }] },
  };
};

/**
 * Whether the caller may link every entry `ref` names: each must exist and be one the caller may
 * read, or update where the link shows on it. A document id is decided on every row `refsQuery`
 * loads of it (each version and locale); a row id on that one row, the row the link is made to.
 * One it cannot find is refused the same way, so the answer tells nothing of what exists.
 */
export const refsVerdict = (
  tables: Tables,
  state: unknown,
  ref: RelationRef,
  rows: readonly unknown[],
  action: "read" | "update" = "read",
): "allow" | "forbidden" => {
  const rules = own(tables.rules, ref.target);
  const caller = reachCaller(tables, ref.target, state);
  if (rules === undefined || caller === undefined) return "allow";
  const documents = new Map<unknown, unknown[]>();
  for (const row of rows) {
    const documentId = field(row, "documentId");
    documents.set(documentId, [...(documents.get(documentId) ?? []), row]);
  }
  const named = [
    ...ref.documentIds,
    ...ref.ids.map((id) =>
      field(
        rows.find((row) => field(row, "id") === id),
        "documentId",
      ),
    ),
  ];
  return named.every((documentId) => {
    const entry = documentId === undefined ? undefined : documents.get(documentId);
    return entry !== undefined && recordVerdict(rules, caller, action, entry) === "allow";
  })
    ? "allow"
    : "forbidden";
};

/**
 * The state a request's reach is decided for: on an action the router opens with `auth: false`,
 * which Strapi authenticates no one for, the public role's; otherwise the request's own.
 */
export const reachState = (rules: TypeRules, state: unknown, action: string): unknown =>
  rules.open.includes(action) ? GUEST_STATE : state;

interface Linked {
  documentIds: string[];
  ids: number[];
}

/** One relation value as a write: what it adds, what it drops by name, and whether it replaces. */
const relationChange = (
  value: unknown,
  toOne: boolean,
): { added: Linked; removed: Linked; replace: boolean } | null => {
  const removed: Linked = { documentIds: [], ids: [] };
  if (isRecord(value) && ("connect" in value || "set" in value || "disconnect" in value)) {
    const connect = linked(own(value, "connect") ?? null);
    const set = linked(own(value, "set") ?? null);
    const disconnect = linked(own(value, "disconnect") ?? null);
    if (connect === null || set === null || disconnect === null) return null;
    const added: Linked = {
      documentIds: [...connect.documentIds, ...set.documentIds],
      ids: [...connect.ids, ...set.ids],
    };
    const replace =
      own(value, "set") !== undefined || (toOne && added.documentIds.length + added.ids.length > 0);
    return { added, removed: disconnect, replace };
  }
  // A shorthand (an id, a list, null) sets the relation to exactly what it names.
  const added = linked(value);
  return added === null ? null : { added, removed, replace: true };
};

/** The checks a relation write needs beyond the entry written, before it is made. */
export interface WritePlan {
  /** Entries the write links or unlinks, each to be read, or updated where the link shows. */
  refs: (RelationRef & { action: "read" | "update" })[];
  /** Mirrored attributes the write replaces: each entry it drops (not kept) must be updatable. */
  replaced: { attribute: string; target: string; kept: Linked }[];
  /** Exclusive attributes: each linked entry's last holder (of this type) must be updatable. */
  stolen: ({ attribute: string } & Linked)[];
}

/**
 * What a write's data asks of the entries it changes besides its own: every entry a reach links
 * must be readable (`relationRefs`); every entry a mirrored link adds or drops must be updatable,
 * since the link shows on it; and every entry an exclusive link takes from its last holder of a
 * type with rules leaves a holder that must be updatable. A caller no role restricts needs none.
 */
export const writePlan = (
  tables: Tables,
  uid: string,
  state: unknown,
  data: Record<string, unknown>,
): Checked<WritePlan> => {
  const plan: WritePlan = { refs: [], replaced: [], stolen: [] };
  const rules = own(tables.rules, uid);
  if (rules === undefined || callerOf(rules, state, "").kind === "unrestricted")
    return { ok: true, value: plan };
  const reads = relationRefs(tables, uid, state, data);
  if (!reads.ok) return { ok: false, message: reads.message };
  plan.refs.push(...reads.value.map((ref) => ({ ...ref, action: "read" as const })));
  for (const [attribute, write] of Object.entries(rules.relations)) {
    const value = own(data, attribute);
    if (value === undefined) continue;
    const change = relationChange(value, write.toOne);
    if (change === null) return { ok: false, message: `Invalid relation value for ${attribute}` };
    const target = own(tables.rules, write.target);
    if (write.mirrored && target?.own === true) {
      const touched = {
        documentIds: [...change.added.documentIds, ...change.removed.documentIds],
        ids: [...change.added.ids, ...change.removed.ids],
      };
      if (touched.documentIds.length + touched.ids.length > 0)
        plan.refs.push({ target: write.target, ...touched, action: "update" });
      if (change.replace)
        plan.replaced.push({ attribute, target: write.target, kept: change.added });
    }
    if (
      write.exclusive &&
      rules.own &&
      change.added.documentIds.length + change.added.ids.length > 0
    )
      plan.stolen.push({ attribute, ...change.added });
  }
  return { ok: true, value: plan };
};

/** What to load of an entry's current links through one attribute. */
export const currentLinksQuery = (
  attribute: string,
  documentId: string,
): Record<string, unknown> => ({
  where: { documentId },
  select: ["id"],
  populate: { [attribute]: { select: ["id", "documentId"] } },
});

/** The document ids an entry's rows link through `attribute` that a replacement does not keep. */
export const droppedLinks = (
  rows: readonly unknown[],
  attribute: string,
  kept: Linked,
): string[] => {
  const dropped = new Set<string>();
  for (const row of rows) {
    const value = field(row, attribute);
    for (const item of Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value]) {
      const documentId = field(item, "documentId");
      const id = field(item, "id");
      if (typeof documentId !== "string") continue;
      if (
        kept.documentIds.includes(documentId) ||
        (typeof id === "number" && kept.ids.includes(id))
      )
        continue;
      dropped.add(documentId);
    }
  }
  return [...dropped];
};

/** What to load of the entries of this type that hold an entry an exclusive link takes. */
export const holdersQuery = (
  rules: TypeRules,
  stolen: { attribute: string } & Linked,
  except: string | null,
): Record<string, unknown> => {
  const query = recordQuery(rules, "");
  const linkedHere = {
    [stolen.attribute]: {
      $or: [{ documentId: { $in: stolen.documentIds } }, { id: { $in: stolen.ids } }],
    },
  };
  return {
    ...query,
    select: [...(query.select as string[]), "documentId"],
    where: except === null ? linkedHere : { $and: [linkedHere, { documentId: { $ne: except } }] },
  };
};

/** Whether the caller may update every entry (each of its rows) among `rows`. */
export const holdersVerdict = (
  rules: TypeRules,
  caller: Caller,
  rows: readonly unknown[],
): "allow" | "forbidden" => {
  const documents = new Map<unknown, unknown[]>();
  for (const row of rows) {
    const documentId = field(row, "documentId");
    documents.set(documentId, [...(documents.get(documentId) ?? []), row]);
  }
  return [...documents.values()].every(
    (entry) => recordVerdict(rules, caller, "update", entry) === "allow",
  )
    ? "allow"
    : "forbidden";
};
