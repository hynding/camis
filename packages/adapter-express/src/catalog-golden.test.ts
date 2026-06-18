import { describe, expect, it } from "vitest";
import { expressAdapter } from "./generate";
import { catalog } from "./__fixtures__/catalog";

describe("express catalog golden", () => {
  const result = expressAdapter.generate(catalog, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("schema golden (relations + full taxonomy + pivot)", async () => {
    await expect(c("src/db/schema.ts")).toMatchFileSnapshot("./__golden__/catalog/schema.ts.txt");
  });
  it("articles routes golden (FK in pick-list)", async () => {
    await expect(c("src/routes/articles.ts")).toMatchFileSnapshot(
      "./__golden__/catalog/articles.routes.ts.txt",
    );
  });
  it("camis.schema.json golden", async () => {
    await expect(c("camis.schema.json")).toMatchFileSnapshot(
      "./__golden__/catalog/camis.schema.json",
    );
  });
  it("file-listing golden", async () => {
    await expect(
      result.files
        .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
        .sort()
        .join("\n"),
    ).toMatchFileSnapshot("./__golden__/catalog/file-listing.txt");
  });
  it("reports a component capability gap", () => {
    expect(result.gaps.gaps.some((g) => g.feature === "component")).toBe(true);
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(catalog, { projectName: "blog" })).toEqual(result);
  });
});
