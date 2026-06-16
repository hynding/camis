import { describe, expect, it } from "vitest";
import { fail, ok, type IrError } from "./errors";

describe("Result helpers", () => {
  it("ok wraps a value", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it("fail wraps errors", () => {
    const err: IrError = { code: "invalid_document", message: "bad", location: {}, path: [] };
    expect(fail([err])).toEqual({ ok: false, errors: [err] });
  });
});
