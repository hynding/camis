import { describe, expect, it } from "vitest";
import { field } from "./fields";

const parse = (v: unknown) => field.safeParse(v);

describe("scalar fields", () => {
  it("accepts a string field with constraints", () => {
    expect(parse({ type: "string", name: "title", required: true, maxLength: 200 }).success).toBe(
      true,
    );
  });

  it("rejects minLength > maxLength (S3)", () => {
    expect(parse({ type: "string", name: "title", minLength: 5, maxLength: 2 }).success).toBe(
      false,
    );
  });

  it("accepts an enumeration with values and a member default", () => {
    expect(
      parse({ type: "enumeration", name: "status", values: ["draft", "live"], default: "draft" })
        .success,
    ).toBe(true);
  });

  it("rejects an empty enumeration (S2)", () => {
    expect(parse({ type: "enumeration", name: "status", values: [] }).success).toBe(false);
  });

  it("rejects an enum default that is not a member (S4)", () => {
    expect(
      parse({ type: "enumeration", name: "status", values: ["draft"], default: "live" }).success,
    ).toBe(false);
  });

  it("rejects min > max on a numeric field (S3)", () => {
    expect(parse({ type: "integer", name: "rank", min: 10, max: 1 }).success).toBe(false);
  });
});
