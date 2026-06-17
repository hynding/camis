export type Value = null | boolean | number | string;
export type EvalError = "TYPE_MISMATCH" | "DIV_BY_ZERO" | "UNKNOWN_VAR";
export type EvalResult = { ok: true; value: Value } | { ok: false; error: EvalError };

export const ok = (value: Value): EvalResult => ({ ok: true, value });
export const err = (error: EvalError): EvalResult => ({ ok: false, error });
