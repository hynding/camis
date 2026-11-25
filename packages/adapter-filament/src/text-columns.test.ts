import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { textSizesBundle } from "./__fixtures__/text-sizes";

describe("text columns sized by their bound (issue #123)", () => {
  const result = filamentAdapter.generate(textSizesBundle, { projectName: "docs" });
  const migration = result.files.find((f) => f.path.endsWith("_create_pages_table.php"))!.content;

  it("migrates each text as the smallest MySQL type that holds its bound", async () => {
    await expect(migration).toMatchFileSnapshot("./__golden__/text-sizes/create_pages_table.php");
  });

  it("reports a bound LONGTEXT cannot hold rather than truncating", () => {
    expect(result.gaps.gaps.filter((g) => g.feature === "textLength")).toEqual([
      {
        feature: "textLength",
        location: { contentType: "Page", field: "unbounded" },
        severity: "downgrade",
        message: expect.stringContaining("1073741824"),
      },
    ]);
  });

  // Strapi's storage layout keeps Strapi's own columns: no migration of ours makes the column.
  it("reports no gap where Strapi's storage layout makes the column", () => {
    const strapi = filamentAdapter.generate(textSizesBundle, {
      projectName: "docs",
      apiStyle: "strapi",
      storageLayout: "strapi",
    });
    expect(strapi.gaps.gaps.filter((g) => g.feature === "textLength")).toEqual([]);
  });
});
