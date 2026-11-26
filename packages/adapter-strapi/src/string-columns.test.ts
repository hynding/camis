import { describe, expect, it } from "vitest";
import { strapiAdapter } from "./generate";
import { importDocument } from "./import/import-document";
import { blog } from "./__fixtures__/blog";
import { stringSizes } from "./__fixtures__/string-sizes";

const generate = () =>
  strapiAdapter.generate({ document: stringSizes, roles: [] }, { projectName: "docs" });
const schema = () =>
  generate().files.find((f) => f.path === "src/api/entry/content-types/entry/schema.json")!.content;

describe("Strapi target: string columns sized by their bound (issue #126)", () => {
  // Strapi 5.48's database layer makes a string a varchar(255) whatever its bound, and lays an
  // attribute's `column` over it; its validator checks maxLength on every database. A longtext for
  // every longer bound that is not unique: Strapi's MySQL schema inspector reads back only a
  // longtext as a text column, so a text or mediumtext one would be altered again on every start.
  it("carries each bound to Strapi and gives a bound past 255 characters a column that holds it", async () => {
    await expect(schema()).toMatchFileSnapshot("./__golden__/string-sizes/entry.schema.json");
  });

  it("regenerates the schema byte for byte", () => {
    expect(schema()).toBe(schema());
  });

  it("reports, located, each bound its column cannot hold", () => {
    expect(generate().gaps.gaps.filter((g) => g.feature === "stringLength")).toEqual([
      {
        feature: "stringLength",
        location: { contentType: "Entry", field: "handle" },
        severity: "downgrade",
        message:
          '"handle" is declared unique and bounded at 1000 characters, more than a unique index holds (a PostgreSQL btree entry holds 2704 bytes with 12 of headers, 673 characters at up to 4 bytes a character); its column settings size it to what a unique index holds, a varchar(673), and Strapi\'s validator checks the bound of 1000, so the database refuses a value longer than 673 characters with an error rather than truncating',
      },
      {
        feature: "stringLength",
        location: { contentType: "Entry", field: "unbounded" },
        severity: "downgrade",
        message:
          '"unbounded" is bounded at 1073741824 characters, more than MySQL\'s largest text column (longtext, 4294967295 bytes at up to 4 bytes a character) holds; its column settings make it a longtext, which MySQL refuses a larger value in rather than truncating',
      },
    ]);
  });

  it("reports nothing where every string's column holds its bound", () => {
    const gaps = strapiAdapter.generate(
      { document: blog, roles: [] },
      { projectName: "blog" },
    ).gaps;
    expect(gaps.gaps.filter((g) => g.feature === "stringLength")).toEqual([]);
  });

  it("imports the generated schema back to the same bounds, its column settings derived from them", () => {
    const { document, gaps } = importDocument(generate().files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(gaps.gaps).toEqual([]);
    expect(document.value.contentTypes[0]!.fields).toEqual(stringSizes.contentTypes[0]!.fields);
  });
});
