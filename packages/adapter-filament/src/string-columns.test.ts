import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { filamentAdapter } from "./generate";
import { emitField } from "./fields";
import { stringSizesBundle } from "./__fixtures__/string-sizes";

describe("string columns sized by their bound (issue #126)", () => {
  const generate = () => filamentAdapter.generate(stringSizesBundle, { projectName: "docs" });
  const migration = () =>
    generate().files.find((f) => f.path.endsWith("_create_entries_table.php"))!.content;

  // A VARCHAR's whole length counts toward MySQL's 65,535 bytes a row, and an index key holds
  // 3,072 bytes: 768 characters of four bytes.
  it("migrates a bound past 255 characters as the text tier holding it, a unique one as a string an index holds", async () => {
    await expect(migration()).toMatchFileSnapshot(
      "./__golden__/string-sizes/create_entries_table.php",
    );
  });

  it("regenerates the migration byte for byte", () => {
    expect(migration()).toBe(migration());
  });

  it("keeps a bound a string column holds as that column's length", () => {
    const column = (field: Partial<Field>) =>
      emitField({ type: "string", name: "code", ...field } as Field).migration;
    expect(column({})).toBe("$table->string('code')->nullable()");
    expect(column({ maxLength: 255 })).toBe("$table->string('code', 255)->nullable()");
    expect(column({ maxLength: 256 })).toBe("$table->text('code')->nullable()");
    expect(column({ maxLength: 4_194_304 })).toBe("$table->longText('code')->nullable()");
    expect(column({ maxLength: 769, unique: true })).toBe(
      "$table->string('code', 768)->nullable()->unique()",
    );
  });

  it("reports, located, each bound its column cannot hold", () => {
    expect(generate().gaps.gaps.filter((g) => g.feature === "stringLength")).toEqual([
      {
        feature: "stringLength",
        location: { contentType: "Entry", field: "handle" },
        severity: "downgrade",
        message:
          '"handle" is unique and bounded at 1000 characters, more than a unique index holds on MySQL (3072 bytes, 768 characters at up to 4 bytes a character); the migration makes it a VARCHAR(768) on every database, which MySQL and PostgreSQL refuse a longer value in rather than truncating',
      },
      {
        feature: "stringLength",
        location: { contentType: "Entry", field: "unbounded" },
        severity: "downgrade",
        message:
          '"unbounded" is bounded at 1073741824 characters, more than MySQL\'s largest text column (LONGTEXT, 4294967295 bytes at up to 4 bytes a character) holds; the migration makes it a LONGTEXT, which MySQL refuses a larger value in rather than truncating',
      },
    ]);
  });

  // Strapi's storage layout keeps the columns Strapi made: a string is a varchar(255) there unless
  // the Strapi project gave it column settings.
  it("reports each bound past 255 characters on Strapi's storage layout, whose columns are Strapi's", () => {
    const strapi = filamentAdapter.generate(stringSizesBundle, {
      projectName: "docs",
      apiStyle: "strapi",
      storageLayout: "strapi",
    });
    const gaps = strapi.gaps.gaps.filter((g) => g.feature === "stringLength");
    expect(gaps.map((g) => g.location.field)).toEqual([
      "headline",
      "abstract",
      "contact",
      "slug",
      "handle",
      "unbounded",
    ]);
    expect(gaps[0]).toEqual({
      feature: "stringLength",
      location: { contentType: "Entry", field: "headline" },
      severity: "downgrade",
      message:
        "\"headline\" is bounded at 1000 characters; on Strapi's storage layout its column is the one Strapi made, a varchar(255) unless the Strapi project gave it column settings (as camis's Strapi target does), which MySQL and PostgreSQL refuse a longer value in",
    });
  });
});
