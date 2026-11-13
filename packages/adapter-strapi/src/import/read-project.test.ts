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
    await materialize(
      strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" }),
      dir,
    );
    const { document } = await readStrapiProject(dir);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes.map((c) => c.name)).toEqual(["Article"]);
  });
});

describe("readStrapiProject custom code", () => {
  it("reports the project's custom code beside its schemas", async () => {
    await materialize(
      strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" }),
      dir,
    );
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "src/api/article/content-types/article"), { recursive: true });
    await writeFile(
      join(dir, "src/api/article/content-types/article/lifecycles.js"),
      "module.exports = { afterCreate() {} };",
    );
    const { gaps } = await readStrapiProject(dir);
    expect(gaps.gaps.map((g) => [g.feature, g.location.file])).toEqual([
      ["lifecycles", "src/api/article/content-types/article/lifecycles.js"],
    ]);
  });
});

describe("readStrapiProject routers", () => {
  it("brings a hand-written core router's routes, policies and middlewares into the IR", async () => {
    await materialize(
      strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" }),
      dir,
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir, "src/api/article/routes/article.ts"),
      `import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::article.article', {
  only: ['find', 'findOne', 'update'],
  config: { find: { auth: false }, update: { policies: ['global::is-owner'] } },
});
`,
    );
    const { document, gaps } = await readStrapiProject(dir);
    expect(gaps.gaps).toEqual([]);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes[0]!.options?.apiActions).toEqual(["list", "read", "update"]);
    expect(document.value.contentTypes[0]!.options?.publicApiActions).toEqual(["list"]);
    expect(document.value.policies).toEqual([
      { name: "IsOwner", contentType: "Article", actions: ["update"] },
    ]);
  });
});

describe("readStrapiProject endpoints", () => {
  it("brings a custom routes file in as endpoints, and reports only what they cannot carry", async () => {
    await materialize(
      strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" }),
      dir,
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir, "src/api/article/routes/custom.ts"),
      "export default { routes: [{ method: 'GET', path: '/articles/trending', handler: 'article.trending', config: { auth: false } }] };\n",
    );
    const { document, gaps } = await readStrapiProject(dir);
    expect(gaps.gaps).toEqual([]);
    expect(document.ok && document.value.endpoints).toEqual([
      {
        name: "ArticleTrending",
        contentType: "Article",
        method: "GET",
        path: "/articles/trending",
        public: true,
      },
    ]);
  });
});
