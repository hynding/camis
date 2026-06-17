import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { toAttribute } from "./attributes";

describe("toAttribute — scalars", () => {
  it("maps a string with constraints", () => {
    const f: Field = { type: "string", name: "title", required: true, maxLength: 200 };
    expect(toAttribute(f)).toEqual({ type: "string", required: true, maxLength: 200 });
  });

  it("lowercases richText/bigInteger/dateTime to Strapi casing", () => {
    expect(toAttribute({ type: "richText", name: "body" })).toEqual({ type: "richtext" });
    expect(toAttribute({ type: "bigInteger", name: "n" })).toEqual({ type: "biginteger" });
    expect(toAttribute({ type: "dateTime", name: "at" })).toEqual({ type: "datetime" });
  });

  it("maps enumeration values to enum", () => {
    expect(
      toAttribute({
        type: "enumeration",
        name: "status",
        values: ["draft", "live"],
        default: "draft",
      }),
    ).toEqual({ type: "enumeration", enum: ["draft", "live"], default: "draft" });
  });

  it("omits absent constraints (no undefined keys)", () => {
    expect(toAttribute({ type: "boolean", name: "flag" })).toEqual({ type: "boolean" });
  });
});
