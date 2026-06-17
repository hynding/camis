import { describe, expect, it } from "vitest";
import { apiFactoryFiles } from "./api-files";

describe("apiFactoryFiles", () => {
  it("emits controller, route, and service factory files under the api dir", () => {
    const files = apiFactoryFiles({ singularName: "article", uid: "api::article.article" });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(Object.keys(byPath).sort()).toEqual([
      "src/api/article/controllers/article.ts",
      "src/api/article/routes/article.ts",
      "src/api/article/services/article.ts",
    ]);
    expect(byPath["src/api/article/controllers/article.ts"]).toContain(
      'createCoreController("api::article.article")',
    );
    expect(byPath["src/api/article/controllers/article.ts"]).toContain("@camis:generated");
  });
});
