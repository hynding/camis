import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { toAttribute, toAttributes } from "./attributes";

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

describe("toAttribute — relations", () => {
  it("maps a relation with an inverse to the api:: target uid + inversedBy", () => {
    expect(
      toAttribute({
        type: "relation",
        name: "author",
        relationKind: "manyToOne",
        target: "Author",
        inverse: "articles",
      }),
    ).toEqual({
      type: "relation",
      relation: "manyToOne",
      target: "api::author.author",
      inversedBy: "articles",
    });
  });

  it("omits inversedBy for a unidirectional relation", () => {
    expect(
      toAttribute({ type: "relation", name: "owner", relationKind: "oneToOne", target: "User" }),
    ).toEqual({ type: "relation", relation: "oneToOne", target: "api::user.user" });
  });
});

describe("toAttribute — uid targetField", () => {
  it("copies uid.targetField to the Strapi attribute", () => {
    expect(toAttribute({ type: "uid", name: "slug", targetField: "title" })).toEqual({
      type: "uid",
      targetField: "title",
    });
  });
});

describe("toAttribute — media", () => {
  it("carries multiple and allowedTypes", () => {
    expect(
      toAttribute({
        type: "media",
        name: "cover",
        multiple: true,
        allowedTypes: ["image", "video"],
      }),
    ).toEqual({ type: "media", multiple: true, allowedTypes: ["image", "video"] });
  });
});

describe("toAttributes — dynamicZone", () => {
  it("skips dynamicZone fields (deferred; generate reports a gap)", () => {
    const attrs = toAttributes([
      { type: "string", name: "title" },
      { type: "dynamicZone", name: "blocks", components: ["Hero"] },
    ]);
    expect(Object.keys(attrs)).toEqual(["title"]);
  });
});

describe("toAttribute — component", () => {
  it("maps a component field to the shared category uid", () => {
    expect(
      toAttribute({ type: "component", name: "seo", component: "SeoMeta", repeatable: false }),
    ).toEqual({ type: "component", component: "shared.seo-meta", repeatable: false });
  });
});

describe("toAttributes", () => {
  it("builds an ordered attributes object keyed by field name", () => {
    const attrs = toAttributes([
      { type: "string", name: "title" },
      { type: "boolean", name: "flag" },
    ]);
    expect(Object.keys(attrs)).toEqual(["title", "flag"]);
    expect(attrs.title).toEqual({ type: "string" });
  });
});
