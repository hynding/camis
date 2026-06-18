import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { camisSchemaFile, importExpressProject } from "./import";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [{ type: "string", name: "title", required: true }],
    },
  ],
  components: [],
};

describe("round-trip", () => {
  it("camisSchemaFile emits a declarative JSON of the document", () => {
    const f = camisSchemaFile(doc);
    expect(f.path).toBe("camis.schema.json");
    expect(JSON.parse(f.content).contentTypes[0].name).toBe("Article");
  });
  it("import(generate's camis.schema.json) normalizes back to the same IR", () => {
    const f = camisSchemaFile(normalize(doc));
    const r = importExpressProject([f]);
    expect(r.document.ok).toBe(true);
    if (r.document.ok) expect(normalize(r.document.value)).toEqual(normalize(doc));
  });
});
