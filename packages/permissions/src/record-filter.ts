import { freeVars, type Expression } from "@camis/expr";
import type { ContentType, FieldType } from "@camis/ir-schema";

/**
 * The user variables a condition may compare a record with, by the kind of value each holds: the
 * account's id, its email, and the name of its role.
 */
export const USER_VARIABLES: Readonly<Record<string, "number" | "string">> = {
  "user.id": "number",
  "user.email": "string",
  "user.role": "string",
};

export type RecordOperand =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "user"; variable: string };

export interface RecordEquality {
  /** The `record.*` variable compared. */
  variable: string;
  value: RecordOperand;
}

/**
 * A condition every target can answer as a query over its rows instead of row by row. A `caller`
 * part reads no record variable, so it holds for every row or none: the target decides it per
 * request with Ring 1 itself, before the query.
 */
export type RecordFilter =
  | ({ kind: "eq" } & RecordEquality)
  | { kind: "caller"; expression: Expression }
  | { kind: "and" | "or"; args: RecordFilter[] };

export interface RecordVariable {
  /** The field the variable reads: the relation itself for `record.<relation>Id`. */
  field: string;
  /** The variable is an owning relation's id. */
  relation: boolean;
  type: FieldType;
}

const NUMERIC = new Set<FieldType>(["integer", "bigInteger", "float", "decimal"]);
const STRINGY = new Set<FieldType>([
  "string",
  "text",
  "richText",
  "email",
  "uid",
  "color",
  "enumeration",
  "date",
  "time",
  "dateTime",
  "timestamp",
]);
// Values Ring 1 has no form for (objects, lists, files, nested entries) are not variables.
const NOT_SCALAR = new Set<FieldType>([
  "relation",
  "polymorphicRelation",
  "polymorphicInverse",
  "component",
  "dynamicZone",
  "media",
  "json",
  "blocks",
]);

/**
 * The `record.*` variables a condition may read on a type: `record.<field>` for each scalar field
 * and `record.<relation>Id` for each owning (`manyToOne`/`oneToOne`) relation. A name two fields
 * claim (a scalar `ownerId` beside a relation `owner`) is dropped, so a condition naming it is
 * refused rather than read off the wrong field.
 */
export const recordVariables = (ct: ContentType): Map<string, RecordVariable> => {
  const variables = new Map<string, RecordVariable>();
  const contested = new Set<string>();
  const claim = (name: string, variable: RecordVariable): void => {
    if (variables.has(name)) contested.add(name);
    variables.set(name, variable);
  };
  for (const f of ct.fields) {
    if (f.type === "relation") {
      if (f.relationKind === "manyToOne" || f.relationKind === "oneToOne")
        claim(`record.${f.name}Id`, { field: f.name, relation: true, type: "integer" });
      continue;
    }
    if (!NOT_SCALAR.has(f.type))
      claim(`record.${f.name}`, { field: f.name, relation: false, type: f.type });
  }
  for (const name of contested) variables.delete(name);
  return variables;
};

/** Whether a field of `type` and `value` are of one kind, so neither side is coerced. */
const comparable = (type: FieldType, value: RecordOperand): boolean => {
  if (value.kind === "user")
    return USER_VARIABLES[value.variable] === "number" ? NUMERIC.has(type) : STRINGY.has(type);
  const v = value.value;
  if (v === null) return true;
  if (typeof v === "number") return NUMERIC.has(type);
  if (typeof v === "boolean") return type === "boolean";
  return STRINGY.has(type);
};

const operand = (
  e: Expression,
  typeOf: (variable: string) => FieldType | undefined,
  users: readonly string[],
): { variable: string; type: FieldType } | RecordOperand | null => {
  if (e.kind === "lit") return { kind: "literal", value: e.value };
  if (e.kind !== "var") return null;
  if (e.name in USER_VARIABLES)
    return users.includes(e.name) ? { kind: "user", variable: e.name } : null;
  const type = typeOf(e.name);
  return type === undefined ? null : { variable: e.name, type };
};

const isRecord = (o: object): o is { variable: string; type: FieldType } => "type" in o;

/**
 * A `record.* == literal | user.*` equality (either order) between operands of one kind, so a
 * query answers it as Ring 1 does, or null. `typeOf` types the record variables the target can
 * query; `users` names the user variables it can bind. One limit is the database's, not the
 * filter's: a string equality is compared under the column's collation, and MySQL's default
 * collations ignore case (and, for most, accents), where Ring 1 compares code points; on MySQL a
 * string condition may match more rows than Ring 1 would. Targets document this where they use it.
 */
export const recordEquality = (
  expr: Expression,
  typeOf: (variable: string) => FieldType | undefined,
  users: readonly string[],
): RecordEquality | null => {
  if (expr.kind !== "eq") return null;
  const left = operand(expr.left, typeOf, users);
  const right = operand(expr.right, typeOf, users);
  if (left === null || right === null) return null;
  const record = isRecord(left) ? left : isRecord(right) ? right : null;
  const value = isRecord(left) ? right : left;
  if (record === null || isRecord(value)) return null;
  if (!comparable(record.type, value)) return null;
  return { variable: record.variable, value };
};

/**
 * `eq`/`and`/`or` over record equalities and caller tests as a filter, or null when any part is
 * outside it.
 */
export const toRecordFilter = (
  expr: Expression,
  typeOf: (variable: string) => FieldType | undefined,
  users: readonly string[],
): RecordFilter | null => {
  const vars = freeVars(expr);
  if (vars.every((v) => users.includes(v))) return { kind: "caller", expression: expr };
  if (expr.kind === "and" || expr.kind === "or") {
    const args: RecordFilter[] = [];
    for (const a of expr.args) {
      const node = toRecordFilter(a, typeOf, users);
      if (node === null) return null;
      args.push(node);
    }
    return { kind: expr.kind, args };
  }
  const equality = recordEquality(expr, typeOf, users);
  return equality === null ? null : { kind: "eq", ...equality };
};
