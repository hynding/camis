import type { Expression } from "./ast";
import type { EvalResult, Value } from "./value";

export interface Vector {
  name: string;
  expr: Expression;
  data: Record<string, Value>;
  expect: EvalResult;
}

const lit = (value: Value): Expression => ({ kind: "lit", value });
const v = (name: string): Expression => ({ kind: "var", name });

export const vectors: Vector[] = [
  { name: "lit number", expr: lit(5), data: {}, expect: { ok: true, value: 5 } },
  { name: "lit string", expr: lit("x"), data: {}, expect: { ok: true, value: "x" } },
  { name: "lit null", expr: lit(null), data: {}, expect: { ok: true, value: null } },
  { name: "var found", expr: v("a"), data: { a: 3 }, expect: { ok: true, value: 3 } },
  { name: "var missing", expr: v("a"), data: {}, expect: { ok: false, error: "UNKNOWN_VAR" } },
  {
    name: "eq numbers true",
    expr: { kind: "eq", left: lit(1), right: lit(1) },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "eq null both",
    expr: { kind: "eq", left: lit(null), right: lit(null) },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "eq one null",
    expr: { kind: "eq", left: lit(null), right: lit(1) },
    data: {},
    expect: { ok: true, value: false },
  },
  {
    name: "eq mixed type",
    expr: { kind: "eq", left: lit(1), right: lit("1") },
    data: {},
    expect: { ok: false, error: "TYPE_MISMATCH" },
  },
  {
    name: "ne strings",
    expr: { kind: "ne", left: lit("a"), right: lit("b") },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "lt numbers",
    expr: { kind: "lt", left: lit(1), right: lit(2) },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "lt strings ascii",
    expr: { kind: "lt", left: lit("a"), right: lit("b") },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "lt numeric-string trap",
    expr: { kind: "lt", left: lit("10"), right: lit("9") },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "lte",
    expr: { kind: "lte", left: lit(2), right: lit(2) },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "gt",
    expr: { kind: "gt", left: lit(3), right: lit(2) },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "gte mixed type",
    expr: { kind: "gte", left: lit(1), right: lit("a") },
    data: {},
    expect: { ok: false, error: "TYPE_MISMATCH" },
  },
  {
    name: "add",
    expr: { kind: "add", left: lit(2), right: lit(3) },
    data: {},
    expect: { ok: true, value: 5 },
  },
  {
    name: "sub",
    expr: { kind: "sub", left: lit(2), right: lit(3) },
    data: {},
    expect: { ok: true, value: -1 },
  },
  {
    name: "mul",
    expr: { kind: "mul", left: lit(2), right: lit(3) },
    data: {},
    expect: { ok: true, value: 6 },
  },
  {
    name: "div float",
    expr: { kind: "div", left: lit(7), right: lit(2) },
    data: {},
    expect: { ok: true, value: 3.5 },
  },
  {
    name: "div exact",
    expr: { kind: "div", left: lit(6), right: lit(3) },
    data: {},
    expect: { ok: true, value: 2 },
  },
  {
    name: "div by zero",
    expr: { kind: "div", left: lit(1), right: lit(0) },
    data: {},
    expect: { ok: false, error: "DIV_BY_ZERO" },
  },
  {
    name: "add type mismatch",
    expr: { kind: "add", left: lit(1), right: lit("x") },
    data: {},
    expect: { ok: false, error: "TYPE_MISMATCH" },
  },
  {
    name: "float ieee",
    expr: { kind: "add", left: lit(0.1), right: lit(0.2) },
    data: {},
    expect: { ok: true, value: 0.1 + 0.2 },
  },
  {
    name: "and short-circuit false",
    expr: { kind: "and", args: [lit(false), v("missing")] },
    data: {},
    expect: { ok: true, value: false },
  },
  {
    name: "and true",
    expr: { kind: "and", args: [lit(true), lit(true)] },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "or short-circuit true",
    expr: { kind: "or", args: [lit(true), v("missing")] },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "and type mismatch",
    expr: { kind: "and", args: [lit(true), lit(1)] },
    data: {},
    expect: { ok: false, error: "TYPE_MISMATCH" },
  },
  {
    name: "not",
    expr: { kind: "not", arg: lit(true) },
    data: {},
    expect: { ok: true, value: false },
  },
  {
    name: "isNull true",
    expr: { kind: "call", fn: "isNull", args: [lit(null)] },
    data: {},
    expect: { ok: true, value: true },
  },
  {
    name: "coalesce",
    expr: { kind: "call", fn: "coalesce", args: [lit(null), lit(7)] },
    data: {},
    expect: { ok: true, value: 7 },
  },
  {
    name: "var in nested expr",
    expr: { kind: "gt", left: v("rank"), right: lit(3) },
    data: { rank: 5 },
    expect: { ok: true, value: true },
  },
];
