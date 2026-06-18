import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { expressAdapter, importExpressProject } from "./index";
import { catalog } from "./__fixtures__/catalog";

describe("express round-trip", () => {
  it("import(generate.camis.schema.json) normalizes back to the IR", () => {
    const files = expressAdapter.generate(catalog, { projectName: "blog" }).files;
    const r = importExpressProject(files);
    expect(r.document.ok).toBe(true);
    if (r.document.ok) expect(normalize(r.document.value)).toEqual(normalize(catalog.document));
  });
});
