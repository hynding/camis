import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "../generate";
import { readStrapiProject } from "./read-project";

const blog = {
  version: 1 as const,
  contentTypes: [
    {
      name: "Article",
      kind: "collection" as const,
      fields: [{ type: "string" as const, name: "title" }],
    },
  ],
  components: [],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "camis-import-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readStrapiProject", () => {
  it("reads a materialized project's declarative schemas into IR", async () => {
    await materialize(strapiAdapter.generate(blog, { projectName: "blog" }), dir);
    const { document } = await readStrapiProject(dir);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes.map((c) => c.name)).toEqual(["Article"]);
  });
});
