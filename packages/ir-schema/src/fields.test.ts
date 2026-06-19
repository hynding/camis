import { describe, expect, it } from "vitest";
import { field, componentField } from "./fields";

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

describe("structural fields", () => {
  it("accepts a relation field", () => {
    expect(
      field.safeParse({
        type: "relation",
        name: "author",
        relationKind: "manyToOne",
        target: "User",
        inverse: "articles",
      }).success,
    ).toBe(true);
  });

  it("accepts a component field", () => {
    expect(
      field.safeParse({ type: "component", name: "seo", component: "SeoMeta", repeatable: false })
        .success,
    ).toBe(true);
  });

  it("accepts a dynamic zone at field level", () => {
    expect(
      field.safeParse({ type: "dynamicZone", name: "blocks", components: ["Hero"] }).success,
    ).toBe(true);
  });

  it("rejects an empty dynamic zone (S7)", () => {
    expect(field.safeParse({ type: "dynamicZone", name: "blocks", components: [] }).success).toBe(
      false,
    );
  });

  it("componentField rejects a dynamic zone (S6/D6)", () => {
    expect(
      componentField.safeParse({ type: "dynamicZone", name: "blocks", components: ["Hero"] })
        .success,
    ).toBe(false);
  });

  it("componentField accepts a relation", () => {
    expect(
      componentField.safeParse({
        type: "relation",
        name: "author",
        relationKind: "oneToOne",
        target: "User",
      }).success,
    ).toBe(true);
  });
});

describe("typed defaults (S9)", () => {
  it("rejects a boolean field with a string default", () => {
    expect(field.safeParse({ type: "boolean", name: "flag", default: "yes" }).success).toBe(false);
  });
  it("rejects an integer field with a string default", () => {
    expect(field.safeParse({ type: "integer", name: "rank", default: "high" }).success).toBe(false);
  });
});

describe("ai annotation on fields", () => {
  it("accepts ai on a text field", () => {
    const r = field.safeParse({
      type: "text",
      name: "summary",
      ai: { prompt: "Sum {{body}}", trigger: "onCreate" },
    });
    expect(r.success).toBe(true);
  });
  it("accepts ai on string and richText", () => {
    expect(
      field.safeParse({
        type: "string",
        name: "blurb",
        ai: { prompt: "{{title}}", trigger: "onUpdate" },
      }).success,
    ).toBe(true);
    expect(
      field.safeParse({
        type: "richText",
        name: "draft",
        ai: { prompt: "{{title}}", trigger: "onCreateOrUpdate" },
      }).success,
    ).toBe(true);
  });
  it("strips ai on an email field (email is not an AI field)", () => {
    const r = field.safeParse({
      type: "email",
      name: "contact",
      ai: { prompt: "{{x}}", trigger: "onCreate" },
    });
    expect(r.success).toBe(true);
    expect((r.success ? r.data : ({} as never)) as Record<string, unknown>).not.toHaveProperty(
      "ai",
    );
  });
});
