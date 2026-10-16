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
  it("reverses media, mapping Strapi's plural kinds to the IR's", () => {
    expect(
      irField(
        "cover",
        { type: "media", multiple: true, allowedTypes: ["images", "files", "videos", "audios"] },
        loc,
      ).field,
    ).toEqual({
      type: "media",
      name: "cover",
      multiple: true,
      allowedTypes: ["image", "file", "video", "audio"],
    });
  });
  // Projects generated before the emitter wrote plural kinds carry the singular form.
  it("accepts media kinds already in the IR's singular form", () => {
    expect(
      irField("cover", { type: "media", allowedTypes: ["image"] }, loc).field,
    ).toEqual({ type: "media", name: "cover", allowedTypes: ["image"] });
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

describe("irField — relations + components", () => {
  it("maps an owner relation (inversedBy) to a single-declaration IR relation", () => {
    expect(
      irField(
        "author",
        {
          type: "relation",
          relation: "manyToOne",
          target: "api::author.author",
          inversedBy: "articles",
        },
        loc,
      ).field,
    ).toEqual({
      type: "relation",
      name: "author",
      relationKind: "manyToOne",
      target: "Author",
      inverse: "articles",
    });
  });
  it("maps a plain (unidirectional) relation without inverse", () => {
    expect(
      irField("owner", { type: "relation", relation: "oneToOne", target: "api::user.user" }, loc)
        .field,
    ).toEqual({ type: "relation", name: "owner", relationKind: "oneToOne", target: "User" });
  });
  it("skips the synthesized inverse side (mappedBy)", () => {
    const r = irField(
      "articles",
      {
        type: "relation",
        relation: "oneToMany",
        target: "api::article.article",
        mappedBy: "author",
      },
      loc,
    );
    expect(r.skip).toBe(true);
    expect(r.field).toBeUndefined();
  });
  it("maps a component ref back to the IR component name", () => {
    expect(
      irField("seo", { type: "component", component: "shared.seo-meta", repeatable: false }, loc)
        .field,
    ).toEqual({ type: "component", name: "seo", component: "SeoMeta", repeatable: false });
  });
});

describe("irField — plugin relation targets", () => {
  it("maps a plugin::users-permissions.user relation to the builtin User target", () => {
    const r = irField(
      "owner",
      { type: "relation", relation: "manyToOne", target: "plugin::users-permissions.user" },
      loc,
    );
    expect(r.field).toEqual({
      type: "relation",
      name: "owner",
      relationKind: "manyToOne",
      target: "User",
    });
    expect(r.builtinUser).toBe(true);
  });

  it("reports other plugin:: relation targets as downgrade gaps", () => {
    const r = irField(
      "file",
      { type: "relation", relation: "oneToOne", target: "plugin::upload.file" },
      loc,
    );
    expect(r.field).toBeUndefined();
    expect(r.gap?.severity).toBe("downgrade");
    expect(r.gap?.feature).toBe("pluginRelation");
  });
});
