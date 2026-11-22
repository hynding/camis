import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";
import { decimalsBundle } from "./__fixtures__/decimals";

const generate = (
  apiStyle: "laravel" | "strapi",
  storageLayout: "laravel" | "strapi" = "laravel",
) => filamentAdapter.generate(decimalsBundle, { projectName: "ledger", apiStyle, storageLayout });
const contentOf = (result: ReturnType<typeof generate>) => (path: string) =>
  result.files.find((f) => f.path === path)?.content ?? "";
const decimalGaps = (result: ReturnType<typeof generate>) =>
  result.gaps.gaps.filter((g) => g.feature === "decimalPrecision");

describe("decimals stating their digits (issue #104)", () => {
  for (const apiStyle of ["laravel", "strapi"] as const) {
    const content = contentOf(generate(apiStyle));
    it(`migrates and casts each decimal with its own digits on the ${apiStyle} API style`, async () => {
      await expect(
        content("database/migrations/0001_01_02_000001_create_ledgers_table.php"),
      ).toMatchFileSnapshot(`./__golden__/decimals/${apiStyle}/create_ledgers_table.php`);
      await expect(
        content("database/migrations/0001_01_02_000002_create_ledgers_entries_table.php"),
      ).toMatchFileSnapshot(`./__golden__/decimals/${apiStyle}/create_ledgers_entries_table.php`);
      await expect(content("app/Models/Ledger.php")).toMatchFileSnapshot(
        `./__golden__/decimals/${apiStyle}/Ledger.model.php`,
      );
      await expect(content("app/Models/LedgerEntries.php")).toMatchFileSnapshot(
        `./__golden__/decimals/${apiStyle}/LedgerEntries.model.php`,
      );
    });
  }

  it("regenerates them byte for byte", () => {
    expect(generate("strapi")).toEqual(generate("strapi"));
    expect(generate("laravel")).toEqual(generate("laravel"));
  });

  it("reports nothing on the Laravel API style, which neither filters nor sorts", () => {
    expect(decimalGaps(generate("laravel"))).toEqual([]);
  });

  it("reports, located, that the Strapi API style filters and sorts a decimal beyond a double as text on SQLite", () => {
    expect(decimalGaps(generate("strapi"))).toEqual([
      {
        feature: "decimalPrecision",
        location: { contentType: "Ledger", field: "balance" },
        severity: "downgrade",
        message:
          '"balance" keeps its 20 digits as text on SQLite, where a filter or a sort on it compares text, not numbers',
      },
      {
        feature: "decimalPrecision",
        location: { component: "Limit", field: "ceiling" },
        severity: "downgrade",
        message:
          '"ceiling" keeps its 18 digits as text on SQLite, where a filter or a sort on it compares text, not numbers',
      },
      {
        feature: "decimalPrecision",
        location: { component: "Entry", field: "amount" },
        severity: "downgrade",
        message:
          '"amount" keeps its 20 digits as text on SQLite, where a filter or a sort on it compares text, not numbers',
      },
    ]);
  });

  it("reports that on Strapi's storage layout SQLite keeps Strapi's column as a double", () => {
    expect(decimalGaps(generate("strapi", "strapi"))[0]).toEqual({
      feature: "decimalPrecision",
      location: { contentType: "Ledger", field: "balance" },
      severity: "downgrade",
      message:
        "\"balance\" keeps 20 digits, but on Strapi's storage layout its column is Strapi's, which SQLite keeps as a double: on SQLite only 15 significant digits are kept",
    });
  });

  it("reports nothing where no decimal states more digits than a double keeps", () => {
    const result = filamentAdapter.generate(blog, { projectName: "blog", apiStyle: "strapi" });
    expect(result.gaps.gaps.filter((g) => g.feature === "decimalPrecision")).toEqual([]);
  });
});
