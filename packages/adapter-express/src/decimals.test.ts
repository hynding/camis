import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { expressAdapterFor } from "./generate";
import { adminResourceFiles } from "./admin-resources";
import { column } from "./fields";
import { decimals } from "./__fixtures__/decimals";

const generate = (dialect: "sqlite" | "mysql" | "pgsql") =>
  expressAdapterFor(dialect).generate({ document: decimals, roles: [] }, { projectName: "ledger" });

describe("Express target: decimals stating their digits (issue #104)", () => {
  it("keeps Drizzle's decimal and numeric where a decimal states no digits", () => {
    const fee = { type: "decimal", name: "fee" } as Field;
    expect(column("mysql", fee).drizzle).toBe("decimal('fee')");
    expect(column("pgsql", fee).drizzle).toBe("numeric('fee')");
    expect(column("sqlite", fee).drizzle).toBe("numeric('fee')");
  });

  it("gives a decimal's column its digits on MySQL and PostgreSQL", () => {
    const rate = { type: "decimal", name: "rate", precision: 9, scale: 4 } as Field;
    expect(column("mysql", rate).drizzle).toBe("decimal('rate', { precision: 9, scale: 4 })");
    expect(column("pgsql", rate).drizzle).toBe("numeric('rate', { precision: 9, scale: 4 })");
    expect(column("sqlite", rate).drizzle).toBe("numeric('rate')");
  });

  // SQLite keeps a NUMERIC column's values as doubles, which keep 15 significant digits.
  it("keeps a decimal beyond a double as text on SQLite", () => {
    const balance = { type: "decimal", name: "balance", precision: 20, scale: 6 } as Field;
    expect(column("sqlite", balance)).toEqual({
      column: "balance",
      drizzle: "text('balance')",
      import: "text",
    });
    expect(column("pgsql", balance).drizzle).toBe(
      "numeric('balance', { precision: 20, scale: 6 })",
    );
  });

  it("gives a decimal kept as text its default as text", () => {
    const balance = {
      type: "decimal",
      name: "balance",
      precision: 20,
      scale: 6,
      default: 1.5,
    } as Field;
    expect(column("sqlite", balance).drizzle).toBe("text('balance').default('1.5')");
    expect(column("mysql", balance).drizzle).toBe(
      "decimal('balance', { precision: 20, scale: 6 }).default(1.5)",
    );
  });

  for (const dialect of ["sqlite", "mysql", "pgsql"] as const) {
    it(`emits the schema with each decimal's column on ${dialect}`, async () => {
      const schema = generate(dialect).files.find((f) => f.path === "src/db/schema.ts")?.content;
      await expect(schema).toMatchFileSnapshot(`./__golden__/decimals/schema.${dialect}.ts.txt`);
    });
  }

  it("regenerates it byte for byte", () => {
    expect(generate("sqlite")).toEqual(generate("sqlite"));
  });

  // Drizzle answers such a decimal as a string, which the generated list sorts in JavaScript.
  it("reports, located, that the list sorts a decimal beyond a double as text and that it is sent as a string", () => {
    const message = (field: string, precision: number): string =>
      `"${field}" keeps its ${precision} digits as a string, which the generated API's list sorts as text, not as a number, on every database; a JSON number sent for it is read as a double first, so an exact value is sent as a string`;
    for (const dialect of ["sqlite", "mysql", "pgsql"] as const) {
      expect(generate(dialect).gaps.gaps.filter((g) => g.feature === "decimalPrecision")).toEqual([
        {
          feature: "decimalPrecision",
          location: { contentType: "Ledger", field: "balance" },
          severity: "downgrade",
          message: message("balance", 20),
        },
        {
          feature: "decimalPrecision",
          location: { component: "Limit", field: "ceiling" },
          severity: "downgrade",
          message: message("ceiling", 18),
        },
      ]);
    }
  });

  it("reports nothing where no decimal states more digits than a double keeps", () => {
    const within = {
      ...decimals,
      contentTypes: [
        {
          name: "Ledger",
          kind: "collection" as const,
          fields: [{ type: "decimal" as const, name: "rate", precision: 15, scale: 4 }],
        },
      ],
      components: [],
    };
    const result = expressAdapterFor("sqlite").generate(
      { document: within, roles: [] },
      { projectName: "ledger" },
    );
    expect(result.gaps.gaps.filter((g) => g.feature === "decimalPrecision")).toEqual([]);
  });

  // react-admin's NumberField and NumberInput parse the value to a JavaScript number.
  it("shows and edits a decimal beyond a double as text in the admin, and the others as numbers", () => {
    const view =
      adminResourceFiles(decimals).find((f) => f.path === "admin/src/resources/ledgers.tsx")
        ?.content ?? "";
    expect(view).toContain('<TextField source="balance" />');
    expect(view).toContain('<TextInput source="balance" />');
    expect(view).toContain('<NumberField source="rate" />');
    expect(view).toContain('<NumberInput source="rate" />');
    expect(view).toContain('<NumberField source="fee" />');
    expect(view).not.toContain('<NumberField source="balance" />');
    expect(view).not.toContain('<NumberInput source="balance" />');
  });
});
