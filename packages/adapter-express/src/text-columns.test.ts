import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { expressAdapterFor } from "./generate";
import { column } from "./fields";

const text = (maxLength?: number, type: "text" | "richText" = "text"): Field =>
  ({ type, name: "body", ...(maxLength === undefined ? {} : { maxLength }) }) as Field;

describe("Express target: text columns sized by their bound (issue #123)", () => {
  // MySQL's TEXT holds 65,535 bytes; a character takes up to 4 bytes of utf8mb4.
  it("sizes a MySQL text by its bound, longtext without one", () => {
    expect(column("mysql", text())).toEqual({
      column: "body",
      drizzle: "longtext('body')",
      import: "longtext",
    });
    expect(column("mysql", text(16_383)).drizzle).toBe("text('body')");
    expect(column("mysql", text(524_288)).drizzle).toBe("mediumtext('body')");
    expect(column("mysql", text(4_194_304)).drizzle).toBe("longtext('body')");
    // One rule, as the Filament target's: rich text is always the largest.
    expect(column("mysql", text(undefined, "richText")).drizzle).toBe("longtext('body')");
    expect(column("mysql", text(100, "richText")).drizzle).toBe("longtext('body')");
  });

  it("keeps the unbounded text of SQLite and PostgreSQL", () => {
    expect(column("sqlite", text(524_288)).drizzle).toBe("text('body')");
    expect(column("pgsql", text()).drizzle).toBe("text('body')");
  });

  describe("a bound the largest MySQL text cannot hold", () => {
    const generate = (dialect: "sqlite" | "mysql" | "pgsql") =>
      expressAdapterFor(dialect).generate(
        {
          document: {
            version: 1,
            contentTypes: [{ name: "Page", kind: "collection", fields: [text(1_073_741_824)] }],
            components: [],
          },
          roles: [],
        },
        { projectName: "docs" },
      );
    const gaps = (dialect: "sqlite" | "mysql" | "pgsql") =>
      generate(dialect).gaps.gaps.filter((g) => g.feature === "textLength");

    it("is reported on MySQL, where its column is the largest text, not truncated", () => {
      expect(gaps("mysql")).toEqual([
        {
          feature: "textLength",
          location: { contentType: "Page", field: "body" },
          severity: "downgrade",
          message: expect.stringContaining("1073741824 characters"),
        },
      ]);
    });

    it.each(["sqlite", "pgsql"] as const)("is no gap on %s, whose text has one type", (dialect) => {
      expect(gaps(dialect)).toEqual([]);
    });
  });
});
