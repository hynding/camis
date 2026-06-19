import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importCommand } from "./import";
import type { Io } from "../io";

const memIo = (
  files: Record<string, string>,
  lines: string[],
  written: Record<string, string>,
): Io => ({
  readFile: (p) =>
    p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`)),
  writeFile: (p, c) => {
    written[p] = c;
    return Promise.resolve();
  },
  materialize: () => Promise.resolve(),
  out: (l) => lines.push(l),
  cwd: "/p",
});

describe("importCommand", () => {
  it("imports an Express camis.schema.json and writes the IR", async () => {
    const schema = JSON.stringify({
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [{ type: "string", name: "title", required: true }],
        },
      ],
      components: [],
    });
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const io = memIo({ "/p/proj/camis.schema.json": schema }, lines, written);
    const code = await importCommand("express", "proj", "out.json", io);
    expect(code).toBe(0);
    expect(written["/p/out.json"]).toBeDefined();
    expect(JSON.parse(written["/p/out.json"]!).contentTypes[0].name).toBe("Article");
  });
  it("errors on filament (no importer)", async () => {
    const lines: string[] = [];
    const code = await importCommand("filament", "proj", "out.json", memIo({}, lines, {}));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("no importer");
  });
  it("imports a minimal Strapi project from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-cli-strapi-"));
    const ctDir = join(dir, "src/api/article/content-types/article");
    await (await import("node:fs/promises")).mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "article", pluralName: "articles", displayName: "Article" },
        attributes: { title: { type: "string", required: true } },
      }),
    );
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const io = memIo({}, lines, written);
    const code = await importCommand("strapi", dir, join(dir, "ir.json"), io);
    expect(code).toBe(0);
    expect(Object.values(written)[0]).toContain('"Article"');
  });
});
