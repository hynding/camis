import { stableJson, withMarker } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { snakeColumn } from "../names";
import { conditionKey, fieldRuleKey } from "./ring1";
import type { ExpressPermissions } from "./project";

const columnToField = (doc: IrDocument): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {};
  for (const ct of doc.contentTypes) {
    const m: Record<string, string> = {};
    for (const f of ct.fields) if (f.type !== "relation") m[snakeColumn(f.name)] = f.name;
    out[ct.name] = m;
  }
  return out;
};

export const emitEnforce = (perms: ExpressPermissions, doc: IrDocument): string => {
  const condKeys: Record<string, Record<string, string>> = {};
  const registryEntries: string[] = [];
  for (const [role, byCt] of Object.entries(perms.conditions)) {
    for (const ct of Object.keys(byCt)) {
      const key = conditionKey(role, ct, "record");
      (condKeys[role] ??= {})[ct] = key;
      registryEntries.push(`  ${key}: C.${key},`);
    }
  }
  const fieldRuleKeys: Record<
    string,
    Record<string, { field: string; access: string; key?: string }[]>
  > = {};
  for (const [role, byCt] of Object.entries(perms.fieldRules)) {
    for (const [ct, rules] of Object.entries(byCt)) {
      fieldRuleKeys[role] ??= {};
      fieldRuleKeys[role][ct] = rules.map((r) => {
        if (!r.when) return { field: r.field, access: r.access };
        const key = fieldRuleKey(role, ct, r.field, r.access);
        registryEntries.push(`  ${key}: C.${key},`);
        return { field: r.field, access: r.access, key };
      });
    }
  }

  const data = `const GRANTS = ${stableJson(perms.grants)} as Record<string, Record<string, string[]>>;
const COND_KEY = ${stableJson(condKeys)} as Record<string, Record<string, string>>;
const FIELD_RULES = ${stableJson(fieldRuleKeys)} as Record<string, Record<string, { field: string; access: string; key?: string }[]>>;
const COLUMN_TO_FIELD = ${stableJson(columnToField(doc))} as Record<string, Record<string, string>>;
const REGISTRY: Record<string, (data: Record<string, Value>) => EvalResult> = {
${registryEntries.sort().join("\n")}
};`;

  return withMarker(`import type { Request } from "express";
import type { EvalResult, Value } from "../ring1/runtime";
import * as C from "./conditions";

${data}

// Fail-closed: only an explicit { ok: true, value: true } may allow.
const allow = (res: EvalResult): boolean => res.ok && res.value === true;

export const roleOf = (req: Request): string => req.camisUser?.role ?? "public";

const flattenUser = (req: Request): Record<string, Value> => {
  const out: Record<string, Value> = {};
  const u = (req.camisUser ?? { role: "public" }) as Record<string, Value>;
  for (const [k, v] of Object.entries(u)) out[\`user.\${k}\`] = v as Value;
  return out;
};

const flattenRecord = (ct: string, row: Record<string, unknown>): Record<string, Value> => {
  const map = COLUMN_TO_FIELD[ct] ?? {};
  const out: Record<string, Value> = {};
  for (const [col, val] of Object.entries(row)) {
    const field = map[col];
    if (field) out[\`record.\${field}\`] = val as Value;
  }
  return out;
};

export const authorizeAction = (role: string, ct: string, action: string): boolean =>
  (GRANTS[role]?.[ct] ?? []).includes(action);

export const recordAllowed = (
  req: Request,
  ct: string,
  row: Record<string, unknown>,
): boolean => {
  const key = COND_KEY[roleOf(req)]?.[ct];
  if (!key) return true;
  const fn = REGISTRY[key];
  if (!fn) return false;
  return allow(fn({ ...flattenUser(req), ...flattenRecord(ct, row) }));
};

const fieldVisible = (
  req: Request,
  ct: string,
  rule: { field: string; access: string; key?: string },
  row: Record<string, unknown>,
): boolean => {
  if (!rule.key) return true;
  const fn = REGISTRY[rule.key];
  if (!fn) return false;
  return allow(fn({ ...flattenUser(req), ...flattenRecord(ct, row) }));
};

export const filterRead = (
  req: Request,
  ct: string,
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const rules = (FIELD_RULES[roleOf(req)]?.[ct] ?? []).filter((r) => r.access === "read");
  if (rules.length === 0) return row;
  const out = { ...row };
  const colOf = Object.fromEntries(
    Object.entries(COLUMN_TO_FIELD[ct] ?? {}).map(([col, field]) => [field, col]),
  );
  for (const rule of rules) {
    if (!fieldVisible(req, ct, rule, row)) delete out[colOf[rule.field] ?? rule.field];
  }
  return out;
};

export const stripWrites = (
  req: Request,
  ct: string,
  proposed: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const rules = (FIELD_RULES[roleOf(req)]?.[ct] ?? []).filter((r) => r.access === "write");
  if (rules.length === 0) return body;
  const out = { ...body };
  const colOf = Object.fromEntries(
    Object.entries(COLUMN_TO_FIELD[ct] ?? {}).map(([col, field]) => [field, col]),
  );
  for (const rule of rules) {
    if (!fieldVisible(req, ct, rule, proposed)) delete out[colOf[rule.field] ?? rule.field];
  }
  return out;
};
`);
};
