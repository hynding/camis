import { describe, expect, it } from "vitest";
import { strapiAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";

describe("golden", () => {
  it("Article schema.json matches the golden snapshot byte-for-byte", async () => {
    const result = strapiAdapter.generate(blog, { projectName: "blog" });
    const schema = result.files.find((f) => f.path.endsWith("article/schema.json"))!.content;
    await expect(schema).toMatchFileSnapshot("./__golden__/article.schema.json");
  });

  it("the full emitted file manifest matches the golden snapshot", async () => {
    const result = strapiAdapter.generate(blog, { projectName: "blog" });
    const listing = result.files
      .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
      .sort()
      .join("\n");
    await expect(listing).toMatchFileSnapshot("./__golden__/file-listing.txt");
  });

  it("regeneration is idempotent (identical result)", () => {
    const a = strapiAdapter.generate(blog, { projectName: "blog" });
    const b = strapiAdapter.generate(blog, { projectName: "blog" });
    expect(a).toEqual(b);
  });
});
