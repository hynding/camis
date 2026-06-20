import { describe, expect, it } from "vitest";
import { validateCommand } from "./validate";
import type { Io } from "../io";

const ioWith = (content: string, lines: string[]): Io => ({
  readFile: () => Promise.resolve(content),
  writeFile: () => Promise.resolve(),
  materialize: () => Promise.resolve(),
  out: (l) => lines.push(l),
  cwd: "/p",
});

describe("validateCommand", () => {
  it("exits 0 and prints a checkmark for a valid IR", async () => {
    const lines: string[] = [];
    const code = await validateCommand(
      "ir.json",
      ioWith(
        JSON.stringify({
          version: 1,
          contentTypes: [
            {
              name: "Article",
              kind: "collection",
              fields: [{ type: "string", name: "title", required: true }],
            },
          ],
          components: [],
        }),
        lines,
      ),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("✓ valid");
  });
  it("exits 1 and prints located errors for an invalid IR", async () => {
    const lines: string[] = [];
    const code = await validateCommand(
      "ir.json",
      ioWith(
        JSON.stringify({
          version: 1,
          contentTypes: [
            {
              name: "Article",
              kind: "collection",
              fields: [{ type: "relation", name: "a", relationKind: "manyToOne", target: "Ghost" }],
            },
          ],
          components: [],
        }),
        lines,
      ),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("✗");
    expect(lines.join("\n")).toContain("unknown_relation_target");
  });
});
