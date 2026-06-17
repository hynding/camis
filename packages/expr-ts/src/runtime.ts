import { err, ok, type EvalResult, type Value } from "@camis/expr";

export type Thunk = () => EvalResult;

const typeOf = (v: Value): "null" | "boolean" | "number" | "string" =>
  v === null ? "null" : (typeof v as "boolean" | "number" | "string");

const force2 = (a: Thunk, b: Thunk, f: (x: Value, y: Value) => EvalResult): EvalResult => {
  const x = a();
  if (!x.ok) return x;
  const y = b();
  if (!y.ok) return y;
  return f(x.value, y.value);
};

const eqValues = (x: Value, y: Value): EvalResult => {
  const tx = typeOf(x);
  const ty = typeOf(y);
  if (tx === "null" && ty === "null") return ok(true);
  if (tx === "null" || ty === "null") return ok(false);
  if (tx !== ty) return err("TYPE_MISMATCH");
  return ok(x === y);
};

// Direct < / > comparison (not subtraction) so number ordering avoids
// floating-point precision loss near MAX_SAFE_INTEGER and stays structurally
// symmetric with the string branch — the PHP runtime must mirror this.
const compare = <T extends number | string>(x: T, y: T): number => (x < y ? -1 : x > y ? 1 : 0);

const order = (x: Value, y: Value, f: (c: number) => boolean): EvalResult => {
  const tx = typeOf(x);
  const ty = typeOf(y);
  if (tx === "number" && ty === "number") return ok(f(compare(x as number, y as number)));
  if (tx === "string" && ty === "string") return ok(f(compare(x as string, y as string)));
  return err("TYPE_MISMATCH");
};

const arith = (x: Value, y: Value, f: (a: number, b: number) => EvalResult): EvalResult => {
  if (typeOf(x) !== "number" || typeOf(y) !== "number") return err("TYPE_MISMATCH");
  return f(x as number, y as number);
};

export const r = {
  lit: (value: Value): EvalResult => ok(value),
  var: (data: Record<string, Value>, name: string): EvalResult =>
    Object.prototype.hasOwnProperty.call(data, name) ? ok(data[name]!) : err("UNKNOWN_VAR"),

  eq: (a: Thunk, b: Thunk): EvalResult => force2(a, b, eqValues),
  ne: (a: Thunk, b: Thunk): EvalResult => {
    const e = force2(a, b, eqValues);
    // eqValues yields ok(true) | ok(false) on success; negate the equal case.
    return e.ok ? ok(e.value === false) : e;
  },
  lt: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => order(x, y, (c) => c < 0)),
  lte: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => order(x, y, (c) => c <= 0)),
  gt: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => order(x, y, (c) => c > 0)),
  gte: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => order(x, y, (c) => c >= 0)),

  add: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => arith(x, y, (m, n) => ok(m + n))),
  sub: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => arith(x, y, (m, n) => ok(m - n))),
  mul: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => arith(x, y, (m, n) => ok(m * n))),
  div: (a: Thunk, b: Thunk): EvalResult =>
    force2(a, b, (x, y) => arith(x, y, (m, n) => (n === 0 ? err("DIV_BY_ZERO") : ok(m / n)))),

  and: (...args: Thunk[]): EvalResult => {
    for (const t of args) {
      const v = t();
      if (!v.ok) return v;
      if (typeof v.value !== "boolean") return err("TYPE_MISMATCH");
      if (v.value === false) return ok(false);
    }
    return ok(true);
  },
  or: (...args: Thunk[]): EvalResult => {
    for (const t of args) {
      const v = t();
      if (!v.ok) return v;
      if (typeof v.value !== "boolean") return err("TYPE_MISMATCH");
      if (v.value === true) return ok(true);
    }
    return ok(false);
  },
  not: (a: Thunk): EvalResult => {
    const v = a();
    if (!v.ok) return v;
    if (typeof v.value !== "boolean") return err("TYPE_MISMATCH");
    return ok(!v.value);
  },
  isNull: (a: Thunk): EvalResult => {
    const v = a();
    return v.ok ? ok(v.value === null) : v;
  },
  coalesce: (...args: Thunk[]): EvalResult => {
    for (const t of args) {
      const v = t();
      if (!v.ok) return v;
      if (v.value !== null) return ok(v.value);
    }
    return ok(null);
  },
};
