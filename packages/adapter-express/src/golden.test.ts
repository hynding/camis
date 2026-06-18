import { describe, expect, it } from "vitest";
import { expressAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";

describe("express golden", () => {
  const result = expressAdapter.generate(blog, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("schema golden", async () => {
    await expect(c("src/db/schema.ts")).toMatchFileSnapshot("./__golden__/schema.ts.txt");
  });
  it("routes golden", async () => {
    await expect(c("src/routes/articles.ts")).toMatchFileSnapshot(
      "./__golden__/articles.routes.ts.txt",
    );
  });
  it("server golden", async () => {
    await expect(c("src/server.ts")).toMatchFileSnapshot("./__golden__/server.ts.txt");
  });
  it("client golden", async () => {
    await expect(c("src/db/client.ts")).toMatchFileSnapshot("./__golden__/client.ts.txt");
  });
  it("package.json golden", async () => {
    await expect(c("package.json")).toMatchFileSnapshot("./__golden__/package.json");
  });
  it("file listing golden", async () => {
    await expect(
      result.files
        .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
        .sort()
        .join("\n"),
    ).toMatchFileSnapshot("./__golden__/file-listing.txt");
  });
  it("idempotent", () => {
    expect(expressAdapter.generate(blog, { projectName: "blog" })).toEqual(result);
  });
});
