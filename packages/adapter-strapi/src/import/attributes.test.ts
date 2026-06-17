import { describe, expect, it } from "vitest";
import { irField } from "./attributes";

const loc = { contentType: "Article" };

describe("irField — scalars", () => {
  it("reverses casing", () => {
    expect(irField("body", { type: "richtext" }, loc).field).toEqual({
      type: "richText",
      name: "body",
    });
    expect(irField("n", { type: "biginteger" }, loc).field).toEqual({
      type: "bigInteger",
      name: "n",
    });
    expect(irField("at", { type: "datetime" }, loc).field).toEqual({
      type: "dateTime",
      name: "at",
    });
  });
  it("copies constraints", () => {
    expect(irField("title", { type: "string", required: true, maxLength: 200 }, loc).field).toEqual(
      { type: "string", name: "title", required: true, maxLength: 200 },
    );
  });
  it("reverses enumeration", () => {
    expect(
      irField("status", { type: "enumeration", enum: ["draft", "live"], default: "draft" }, loc)
        .field,
    ).toEqual({ type: "enumeration", name: "status", values: ["draft", "live"], default: "draft" });
  });
  it("reverses media", () => {
    expect(
      irField("cover", { type: "media", multiple: true, allowedTypes: ["image"] }, loc).field,
    ).toEqual({ type: "media", name: "cover", multiple: true, allowedTypes: ["image"] });
  });
  it("reverses uid targetField", () => {
    expect(irField("slug", { type: "uid", targetField: "title" }, loc).field).toEqual({
      type: "uid",
      name: "slug",
      targetField: "title",
    });
  });
  it("returns a gap for an unknown type", () => {
    const r = irField("weird", { type: "customField" }, loc);
    expect(r.field).toBeUndefined();
    expect(r.gap?.feature).toBe("customField");
  });
});
