import { describe, expect, it } from "vitest";
import { strapiAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";
import { roundTrip } from "./__fixtures__/round-trip";

describe("golden", () => {
  it("Article schema.json matches the golden snapshot byte-for-byte", async () => {
    const result = strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" });
    const schema = result.files.find((f) => f.path.endsWith("article/schema.json"))!.content;
    await expect(schema).toMatchFileSnapshot("./__golden__/article.schema.json");
  });

  it("the full emitted file manifest matches the golden snapshot", async () => {
    const result = strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" });
    const listing = result.files
      .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
      .sort()
      .join("\n");
    await expect(listing).toMatchFileSnapshot("./__golden__/file-listing.txt");
  });

  it("regeneration is idempotent (identical result)", () => {
    const a = strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" });
    const b = strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" });
    expect(a).toEqual(b);
  });

  it("component schema.json matches the golden", async () => {
    const result = strapiAdapter.generate(
      { document: roundTrip, roles: [] },
      { projectName: "blog" },
    );
    const comp = result.files.find(
      (f) => f.path === "src/components/shared/seo-meta.json",
    )!.content;
    await expect(comp).toMatchFileSnapshot("./__golden__/seo-meta.component.json");
  });

  it("Author schema.json (with synthesized inverse) matches the golden", async () => {
    const result = strapiAdapter.generate(
      { document: roundTrip, roles: [] },
      { projectName: "blog" },
    );
    const author = result.files.find((f) => f.path.endsWith("author/schema.json"))!.content;
    await expect(author).toMatchFileSnapshot("./__golden__/author.schema.json");
  });
});
