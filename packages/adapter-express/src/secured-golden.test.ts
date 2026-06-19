import { describe, expect, it } from "vitest";
import { expressAdapter } from "./generate";
import { secured } from "./__fixtures__/secured";

describe("secured golden", () => {
  const result = expressAdapter.generate(secured, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("conditions golden", async () => {
    await expect(c("src/permissions/conditions.ts")).toMatchFileSnapshot(
      "./__golden__/secured/conditions.ts.txt",
    );
  });
  it("enforce golden", async () => {
    await expect(c("src/permissions/enforce.ts")).toMatchFileSnapshot(
      "./__golden__/secured/enforce.ts.txt",
    );
  });
  it("auth store golden (seed)", async () => {
    await expect(c("src/auth/store.ts")).toMatchFileSnapshot("./__golden__/secured/store.ts.txt");
  });
  it("secured articles routes golden", async () => {
    await expect(c("src/routes/articles.ts")).toMatchFileSnapshot(
      "./__golden__/secured/articles.routes.ts.txt",
    );
  });
  it("server golden (auth wiring)", async () => {
    await expect(c("src/server.ts")).toMatchFileSnapshot("./__golden__/secured/server.ts.txt");
  });
  it("admin App golden", async () => {
    await expect(c("admin/src/App.tsx")).toMatchFileSnapshot(
      "./__golden__/secured/admin.App.tsx.txt",
    );
  });
  it("admin articles resource golden", async () => {
    await expect(c("admin/src/resources/articles.tsx")).toMatchFileSnapshot(
      "./__golden__/secured/admin.articles.tsx.txt",
    );
  });
  it("admin dataProvider golden", async () => {
    await expect(c("admin/src/dataProvider.ts")).toMatchFileSnapshot(
      "./__golden__/secured/admin.dataProvider.ts.txt",
    );
  });
  it("file-listing golden", async () => {
    await expect(
      result.files
        .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
        .sort()
        .join("\n"),
    ).toMatchFileSnapshot("./__golden__/secured/file-listing.txt");
  });
  it("reports the publishAction gap (Editor grants publish, no REST analog)", () => {
    expect(result.gaps.gaps.some((g) => g.feature === "publishAction")).toBe(true);
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(secured, { projectName: "blog" })).toEqual(result);
  });
});
