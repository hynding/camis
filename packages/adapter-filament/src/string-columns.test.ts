import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { filamentAdapter } from "./generate";
import { emitField } from "./fields";
import type { IrBundle } from "@camis/permissions";
import { stringSizesBundle } from "./__fixtures__/string-sizes";

describe("string columns sized by their bound (issue #126)", () => {
  const generate = () => filamentAdapter.generate(stringSizesBundle, { projectName: "docs" });
  const migration = () =>
    generate().files.find((f) => f.path.endsWith("_create_entries_table.php"))!.content;

  // A VARCHAR's whole length counts toward MySQL's 65,535 bytes a row, and a PostgreSQL btree entry
  // holds 2,704 bytes with its 12 bytes of headers (MySQL's index key 3,072): 673 characters of four
  // bytes.
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
    expect(column({ maxLength: 673, unique: true })).toBe(
      "$table->string('code', 673)->nullable()->unique()",
    );
    expect(column({ maxLength: 674, unique: true })).toBe(
      "$table->string('code', 673)->nullable()->unique()",
    );
  });

  it("reports, located, each bound its column cannot hold", () => {
    expect(generate().gaps.gaps.filter((g) => g.feature === "stringLength")).toEqual([
      {
        feature: "stringLength",
        location: { contentType: "Entry", field: "handle" },
        severity: "downgrade",
        message:
          '"handle" is declared unique and bounded at 1000 characters, more than a unique index holds (a PostgreSQL btree entry holds 2704 bytes with 12 of headers, 673 characters at up to 4 bytes a character); the migration sizes it to what a unique index holds, a VARCHAR(673) on every database, whether or not the field keeps its index, and a value longer than 673 characters is refused as invalid',
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

  // On the Strapi API style a draft-and-publish type's unique field loses its index (its uniqueness
  // is the validator's) and keeps the column a unique index holds, as the gap says.
  it("words the gap for a field declared unique, which may have lost its index", () => {
    const drafted = filamentAdapter.generate(
      {
        ...stringSizesBundle,
        document: {
          ...stringSizesBundle.document,
          contentTypes: stringSizesBundle.document.contentTypes.map((ct) => ({
            ...ct,
            options: { draftPublish: true },
          })),
        },
      },
      { projectName: "docs", apiStyle: "strapi" },
    );
    const migration = drafted.files.find((f) => f.path.endsWith("_create_entries_table.php"))!;
    expect(migration.content).toContain("$table->string('handle', 673)->nullable();");
    expect(
      drafted.gaps.gaps.find((g) => g.feature === "stringLength" && g.location.field === "handle")!
        .message,
    ).toContain("is declared unique and bounded at 1000 characters");
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
      "tagline",
    ]);
    expect(gaps[0]).toEqual({
      feature: "stringLength",
      location: { contentType: "Entry", field: "headline" },
      severity: "downgrade",
      message:
        "\"headline\" is bounded at 1000 characters; on Strapi's storage layout its column is the one Strapi made, a varchar(255) unless the Strapi project gave it column settings (as camis's Strapi target does), which no migration of ours can know, so the API refuses a value longer than 255 characters",
    });
  });
});

// MySQL takes no literal default on a TEXT column (ER_BLOB_CANT_HAVE_DEFAULT), and the migration
// serves every database, so the model applies such a default on create instead.
describe("defaults on text columns (issue #126)", () => {
  const generate = () => filamentAdapter.generate(stringSizesBundle, { projectName: "docs" });
  const file = (suffix: string) => generate().files.find((f) => f.path.endsWith(suffix))!.content;

  it("migrates a text column without its default and keeps a string column's", () => {
    const column = (field: Partial<Field>) =>
      emitField({ type: "string", name: "code", ...field } as Field).migration;
    expect(column({ maxLength: 255, default: "x" })).toBe(
      "$table->string('code', 255)->nullable()->default('x')",
    );
    expect(column({ maxLength: 256, default: "x" })).toBe("$table->text('code')->nullable()");
    expect(column({ type: "text", maxLength: 1000, default: "x" })).toBe(
      "$table->text('code')->nullable()",
    );
    expect(column({ type: "richText", default: "x" })).toBe("$table->longText('code')->nullable()");
    expect(column({ maxLength: 1000, unique: true, default: "x" })).toBe(
      "$table->string('code', 673)->nullable()->unique()->default('x')",
    );
  });

  it("applies the default in the model's attributes", async () => {
    await expect(file("Models/Entry.php")).toMatchFileSnapshot(
      "./__golden__/string-sizes/Entry.php",
    );
  });

  it("applies a component field's default in its child model", () => {
    const bundle = {
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Entry",
            kind: "collection",
            names: { plural: "Entries" },
            fields: [
              { type: "component", name: "byline", component: "Byline", repeatable: false },
              { type: "component", name: "credits", component: "Byline", repeatable: true },
            ],
          },
        ],
        components: [
          {
            name: "Byline",
            fields: [{ type: "string", name: "credit", maxLength: 400, default: "staff" }],
          },
        ],
      },
      roles: [],
    } as unknown as IrBundle;
    const files = filamentAdapter.generate(bundle, {
      projectName: "docs",
      apiStyle: "strapi",
    }).files;
    // The single component's columns are its entry's own; the repeatable one's rows a child table's.
    const model = (name: string) => files.find((f) => f.path === `app/Models/${name}.php`)!.content;
    expect(model("Entry")).toContain(
      "    protected $attributes = [\n        'byline_credit' => 'staff',\n    ];\n",
    );
    expect(model("EntryCredits")).toContain(
      "    protected $attributes = [\n        'credit' => 'staff',\n    ];\n",
    );
    const migrations = files.filter((f) => f.path.startsWith("database/migrations/"));
    expect(migrations.map((f) => f.content).join("")).not.toContain("default('staff')");
  });

  it("reports, located, each default the application applies rather than the database", () => {
    expect(generate().gaps.gaps.filter((g) => g.feature === "textDefault")).toEqual([
      {
        feature: "textDefault",
        location: { contentType: "Entry", field: "tagline" },
        severity: "downgrade",
        message:
          '"tagline" has a default, and its column is a text column, which MySQL gives no default; the model applies the default when it creates a row, not the database, so a row inserted without the model gets none',
      },
      {
        feature: "textDefault",
        location: { contentType: "Entry", field: "summary" },
        severity: "downgrade",
        message:
          '"summary" has a default, and its column is a text column, which MySQL gives no default; the model applies the default when it creates a row, not the database, so a row inserted without the model gets none',
      },
    ]);
  });

  // Strapi's storage layout has no migration of ours: Strapi made the columns and applies defaults.
  it("reports nothing on Strapi's storage layout", () => {
    const strapi = filamentAdapter.generate(stringSizesBundle, {
      projectName: "docs",
      apiStyle: "strapi",
      storageLayout: "strapi",
    });
    expect(strapi.gaps.gaps.filter((g) => g.feature === "textDefault")).toEqual([]);
  });
});
