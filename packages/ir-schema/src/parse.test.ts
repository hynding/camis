import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse";

const doc = (overrides: Record<string, unknown>) => ({
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
  ...overrides,
});

describe("parseDocument", () => {
  it("returns ok for a valid document", () => {
    const r = parseDocument(doc({}));
    expect(r.ok).toBe(true);
  });

  it("maps a duplicate-field issue to a located IrError", () => {
    const r = parseDocument(
      doc({
        contentTypes: [
          {
            name: "Article",
            kind: "collection",
            fields: [
              { type: "string", name: "title" },
              { type: "text", name: "title" },
            ],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.code === "duplicate_field");
    expect(e?.location).toMatchObject({ contentType: "Article", field: "title" });
  });

  it("maps a bad identifier to invalid_identifier", () => {
    const r = parseDocument(
      doc({
        contentTypes: [{ name: "article", kind: "collection", fields: [] }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((x) => x.code === "invalid_identifier")).toBe(true);
  });

  it("maps a wrong-typed default to invalid_default_type", () => {
    const r = parseDocument(
      doc({
        contentTypes: [
          {
            name: "Article",
            kind: "collection",
            fields: [{ type: "boolean", name: "flag", default: "yes" }],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.code === "invalid_default_type")).toBe(true);
  });

  it("locates a decimal's digits a database cannot take at its content type and field", () => {
    const r = parseDocument(
      doc({
        contentTypes: [
          {
            name: "Account",
            kind: "collection",
            fields: [{ type: "decimal", name: "balance", precision: 70, scale: 6 }],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      {
        code: "invalid_decimal_digits",
        message: "precision must be a whole number from 1 to 65",
        location: { contentType: "Account", field: "balance" },
        path: ["contentTypes", 0, "fields", 0, "precision"],
      },
    ]);
  });

  it("emits errors in deterministic (path) order", () => {
    const r = parseDocument(
      doc({
        contentTypes: [
          {
            name: "Article",
            kind: "collection",
            fields: [
              { type: "string", name: "id" },
              { type: "text", name: "id" },
            ],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const sorted = [...r.errors].sort((a, b) =>
      JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)),
    );
    expect(r.errors.map((e) => e.code)).toEqual(sorted.map((e) => e.code));
  });
});
