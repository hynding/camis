import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { expressAdapterFor } from "./generate";
import { column } from "./fields";

const string = (field: Partial<Field> = {}): Field =>
  ({ type: "string", name: "code", ...field }) as Field;

describe("Express target: string columns sized by their bound (issue #126)", () => {
  // A VARCHAR's whole length counts toward MySQL's 65,535 bytes a row, and a PostgreSQL btree entry
  // holds 2,704 bytes with its 12 bytes of headers (MySQL's index key 3,072): 673 characters of four
  // bytes.
  it("sizes a MySQL string by its bound: a varchar up to 255 characters, the text tier holding a longer one", () => {
    const mysql = (field: Partial<Field>) => column("mysql", string(field));
    expect(mysql({})).toEqual({
      column: "code",
      drizzle: "varchar('code', { length: 255 })",
      import: "varchar",
    });
    expect(mysql({ maxLength: 40 }).drizzle).toBe("varchar('code', { length: 40 })");
    expect(mysql({ maxLength: 1000 })).toEqual({
      column: "code",
      drizzle: "text('code')",
      import: "text",
    });
    expect(mysql({ maxLength: 20_000 }).drizzle).toBe("mediumtext('code')");
    expect(mysql({ maxLength: 4_194_304 }).drizzle).toBe("longtext('code')");
    expect(column("mysql", { type: "email", name: "code", maxLength: 320 } as Field).drizzle).toBe(
      "text('code')",
    );
  });

  it.each(["mysql", "pgsql"] as const)(
    "keeps a unique %s string a varchar no longer than an index entry holds",
    (dialect) => {
      expect(column(dialect, string({ maxLength: 300, unique: true })).drizzle).toBe(
        "varchar('code', { length: 300 }).unique()",
      );
      expect(column(dialect, string({ maxLength: 673, unique: true })).drizzle).toBe(
        "varchar('code', { length: 673 }).unique()",
      );
      expect(column(dialect, string({ maxLength: 674, unique: true })).drizzle).toBe(
        "varchar('code', { length: 673 }).unique()",
      );
    },
  );

  // PostgreSQL's text holds any length; only a unique one is bounded, by its btree entry.
  it("sizes a PostgreSQL string by its bound: a varchar up to 255 characters, text past it", () => {
    expect(column("pgsql", string()).drizzle).toBe("varchar('code', { length: 255 })");
    expect(column("pgsql", string({ maxLength: 40 })).drizzle).toBe(
      "varchar('code', { length: 40 })",
    );
    expect(column("pgsql", string({ maxLength: 1000 }))).toEqual({
      column: "code",
      drizzle: "text('code')",
      import: "text",
    });
  });

  it("keeps SQLite's text, which takes any length", () => {
    expect(column("sqlite", string({ maxLength: 40 })).drizzle).toBe("text('code')");
    expect(column("sqlite", string({ maxLength: 1000, unique: true })).drizzle).toBe(
      "text('code').unique()",
    );
  });

  describe("a bound no column holds", () => {
    const gaps = (dialect: "sqlite" | "mysql" | "pgsql") =>
      expressAdapterFor(dialect)
        .generate(
          {
            document: {
              version: 1,
              contentTypes: [
                {
                  name: "Entry",
                  kind: "collection",
                  fields: [
                    string({ name: "slug", maxLength: 673, unique: true }),
                    string({ name: "handle", maxLength: 1000, unique: true }),
                    string({ name: "body", maxLength: 1_073_741_824 }),
                  ],
                },
              ],
              components: [],
            },
            roles: [],
          },
          { projectName: "docs" },
        )
        .gaps.gaps.filter((g) => g.feature === "stringLength");

    it("is reported, located, on MySQL", () => {
      expect(gaps("mysql")).toEqual([
        {
          feature: "stringLength",
          location: { contentType: "Entry", field: "handle" },
          severity: "downgrade",
          message:
            '"handle" is unique and bounded at 1000 characters, more than a unique index holds (a PostgreSQL btree entry holds 2704 bytes with 12 of headers, 673 characters at up to 4 bytes a character); the Drizzle schema makes it a varchar(673), and the API refuses a value longer than 673 characters',
        },
        {
          feature: "stringLength",
          location: { contentType: "Entry", field: "body" },
          severity: "downgrade",
          message:
            '"body" is bounded at 1073741824 characters, more than MySQL\'s largest text type (longtext, 4294967295 bytes at up to 4 bytes a character) holds; the Drizzle schema makes it a longtext, which MySQL refuses a larger value in rather than truncating',
        },
      ]);
    });

    it("is reported, located, on PostgreSQL for a unique string only, whose text holds any bound", () => {
      expect(gaps("pgsql")).toEqual([
        {
          feature: "stringLength",
          location: { contentType: "Entry", field: "handle" },
          severity: "downgrade",
          message:
            '"handle" is unique and bounded at 1000 characters, more than a unique index holds (a PostgreSQL btree entry holds 2704 bytes with 12 of headers, 673 characters at up to 4 bytes a character); the Drizzle schema makes it a varchar(673), and the API refuses a value longer than 673 characters',
        },
      ]);
    });

    it("is no gap on SQLite, whose text holds any bound, indexed or not", () => {
      expect(gaps("sqlite")).toEqual([]);
    });
  });
});

// MySQL takes no literal default on a TEXT column (ER_BLOB_CANT_HAVE_DEFAULT), so Drizzle applies
// such a default when it inserts a row instead; PostgreSQL's and SQLite's text take one.
describe("Express target: defaults on MySQL text columns (issue #126)", () => {
  it("applies a text column's default in Drizzle on MySQL", () => {
    const mysql = (field: Partial<Field>) => column("mysql", string(field)).drizzle;
    expect(mysql({ maxLength: 40, default: "x" })).toBe(
      "varchar('code', { length: 40 }).default('x')",
    );
    expect(mysql({ maxLength: 1000, default: "x" })).toBe("text('code').$defaultFn(() => 'x')");
    expect(mysql({ type: "text", maxLength: 1000, default: "x" } as Partial<Field>)).toBe(
      "text('code').$defaultFn(() => 'x')",
    );
    expect(mysql({ type: "richText", default: "x" } as Partial<Field>)).toBe(
      "longtext('code').$defaultFn(() => 'x')",
    );
    expect(mysql({ type: "enumeration", values: ["a", "b"], default: "a" } as Partial<Field>)).toBe(
      "text('code').$defaultFn(() => 'a')",
    );
  });

  it.each(["sqlite", "pgsql"] as const)("keeps the database default on %s", (dialect) => {
    expect(column(dialect, string({ maxLength: 1000, default: "x" })).drizzle).toBe(
      "text('code').default('x')",
    );
  });

  const gaps = (dialect: "sqlite" | "mysql" | "pgsql") =>
    expressAdapterFor(dialect)
      .generate(
        {
          document: {
            version: 1,
            contentTypes: [
              {
                name: "Entry",
                kind: "collection",
                fields: [
                  string({ name: "label", maxLength: 100, default: "hi" }),
                  string({ name: "tagline", maxLength: 500, default: "hello" }),
                  string({ name: "plain", maxLength: 500 }),
                ],
              },
            ],
            components: [],
          },
          roles: [],
        },
        { projectName: "docs" },
      )
      .gaps.gaps.filter((g) => g.feature === "textDefault");

  it("reports, located, each default Drizzle applies rather than MySQL", () => {
    expect(gaps("mysql")).toEqual([
      {
        feature: "textDefault",
        location: { contentType: "Entry", field: "tagline" },
        severity: "downgrade",
        message:
          '"tagline" has a default, and its MySQL column is a text, which takes no default; Drizzle applies the default when it inserts a row, not the database, so a row inserted without Drizzle gets none',
      },
    ]);
  });

  it.each(["sqlite", "pgsql"] as const)("reports nothing on %s", (dialect) => {
    expect(gaps(dialect)).toEqual([]);
  });
});
