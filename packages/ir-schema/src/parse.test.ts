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
