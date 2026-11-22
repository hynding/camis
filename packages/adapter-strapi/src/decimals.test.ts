import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { strapiAdapter } from "./generate";
import { importDocument } from "./import/import-document";
import { blog } from "./__fixtures__/blog";
import { decimals } from "./__fixtures__/decimals";

const generate = () =>
  strapiAdapter.generate({ document: decimals, roles: [] }, { projectName: "ledger" });
const content = (path: string) => generate().files.find((f) => f.path === path)?.content ?? "";

describe("Strapi target: decimals stating their digits (issue #104)", () => {
  it("gives each decimal's column its digits, and leaves one stating none to Strapi", async () => {
    await expect(content("src/api/ledger/content-types/ledger/schema.json")).toMatchFileSnapshot(
      "./__golden__/decimals/ledger.schema.json",
    );
    await expect(content("src/components/shared/limit.json")).toMatchFileSnapshot(
      "./__golden__/decimals/limit.component.json",
    );
  });

  it("regenerates them byte for byte", () => {
    expect(generate()).toEqual(generate());
  });

  // Strapi 5.48's database layer reads and writes a decimal as a JavaScript number (NumberField's
  // toDB and fromDB), and its REST API validates one as z.number(), on every database.
  it("reports, located, each decimal stating more digits than a double keeps", () => {
    expect(generate().gaps.gaps.filter((g) => g.feature === "decimalPrecision")).toEqual([
      {
        feature: "decimalPrecision",
        location: { contentType: "Ledger", field: "balance" },
        severity: "downgrade",
        message:
          '"balance" keeps 20 digits, but Strapi reads and writes a decimal as a JavaScript number, which keeps 15 significant digits: its values are rounded to them',
      },
      {
        feature: "decimalPrecision",
        location: { component: "Limit", field: "ceiling" },
        severity: "downgrade",
        message:
          '"ceiling" keeps 18 digits, but Strapi reads and writes a decimal as a JavaScript number, which keeps 15 significant digits: its values are rounded to them',
      },
    ]);
  });

  it("reports nothing where no decimal states more digits than a double keeps", () => {
    const gaps = strapiAdapter.generate(
      { document: blog, roles: [] },
      { projectName: "blog" },
    ).gaps;
    expect(gaps.gaps.filter((g) => g.feature === "decimalPrecision")).toEqual([]);
  });

  it("imports the generated schema back to the same digits", () => {
    const { document, gaps } = importDocument(generate().files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(gaps.gaps).toEqual([]);
    expect(normalize(document.value)).toEqual(normalize(decimals));
  });
});
