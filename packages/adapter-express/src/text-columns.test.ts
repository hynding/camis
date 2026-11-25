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
    expect(column("mysql", text(undefined, "richText")).drizzle).toBe("longtext('body')");
  });

  it("keeps the unbounded text of SQLite and PostgreSQL", () => {
    expect(column("sqlite", text(524_288)).drizzle).toBe("text('body')");
    expect(column("pgsql", text()).drizzle).toBe("text('body')");
  });

  it("reports a bound LONGTEXT cannot hold rather than truncating", () => {
    const result = expressAdapterFor("mysql").generate(
      {
        document: {
          version: 1,
          contentTypes: [
            {
              name: "Page",
              kind: "collection",
              fields: [text(1_073_741_824)],
            },
          ],
          components: [],
        },
        roles: [],
      },
      { projectName: "docs" },
    );
    expect(result.gaps.gaps.filter((g) => g.feature === "textLength")).toHaveLength(1);
  });
});
