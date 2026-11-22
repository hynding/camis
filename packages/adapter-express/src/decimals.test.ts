import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { expressAdapterFor } from "./generate";
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

  for (const dialect of ["sqlite", "mysql", "pgsql"] as const) {
    it(`emits the schema with each decimal's column on ${dialect}`, async () => {
      const schema = generate(dialect).files.find((f) => f.path === "src/db/schema.ts")?.content;
      await expect(schema).toMatchFileSnapshot(`./__golden__/decimals/schema.${dialect}.ts.txt`);
    });
  }

  it("regenerates it byte for byte and reports no gap", () => {
    expect(generate("sqlite")).toEqual(generate("sqlite"));
    expect(generate("sqlite").gaps.gaps.filter((g) => g.feature === "decimalPrecision")).toEqual(
      [],
    );
  });
});
