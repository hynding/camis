import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "camis-strapi-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("structural smoke", () => {
  it("materializes a well-formed project tree", async () => {
    await materialize(strapiAdapter.generate(blog, { projectName: "blog" }), dir);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    const schema = JSON.parse(
      await readFile(join(dir, "src/api/article/content-types/article/schema.json"), "utf8"),
    );
    expect(schema.kind).toBe("collectionType");
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@strapi/strapi"]).toMatch(/^5\./);
  });

  it("materialize is idempotent on disk (second run leaves files unchanged)", async () => {
    const result = strapiAdapter.generate(blog, { projectName: "blog" });
    await materialize(result, dir);
    const before = await readFile(
      join(dir, "src/api/article/content-types/article/schema.json"),
      "utf8",
    );
    await materialize(result, dir);
    const after = await readFile(
      join(dir, "src/api/article/content-types/article/schema.json"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});
