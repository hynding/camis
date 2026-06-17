import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { strapiAdapter } from "./generate";
import { importDocument } from "./import/import-document";
import { roundTrip } from "./__fixtures__/round-trip";

describe("round-trip", () => {
  it("import(generate(ir)) normalizes to the same IR", () => {
    const files = strapiAdapter.generate(roundTrip, { projectName: "blog" }).files;
    const { document, gaps } = importDocument(files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(gaps.gaps).toEqual([]);
    expect(normalize(document.value)).toEqual(normalize(roundTrip));
  });
});
