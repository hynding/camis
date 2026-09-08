import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { catalog } from "../__fixtures__/catalog";

describe("filamentAdapter apiStyle strapi", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("file listing golden", async () => {
    await expect(
      result.files
        .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
        .sort()
        .join("\n"),
    ).toMatchFileSnapshot("./__golden__/strapi-api/file-listing.txt");
  });
  it("Note model gains scopeForUser", async () => {
    await expect(content("app/Models/Note.php")).toMatchFileSnapshot(
      "./__golden__/strapi-api/Note.model.php",
    );
  });
  it("emits no laravel-style controllers and reports no gaps for the OYL-shaped fixture", () => {
    expect(
      result.files.some(
        (f) => f.path === "app/Http/Controllers/Api/NoteApiController.php" && f.mode === "seed",
      ),
    ).toBe(true);
    expect(
      result.files.some(
        (f) => f.path === "app/Http/Controllers/Api/Generated/NoteApiController.php",
      ),
    ).toBe(true);
    expect(result.gaps.gaps).toEqual([]);
  });
  it("is idempotent", () => {
    expect(
      filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi" }),
    ).toEqual(result);
  });
  it("apiStyle absent leaves the laravel style byte-identical", () => {
    expect(filamentAdapter.generate(catalog, { projectName: "blog" })).toEqual(
      filamentAdapter.generate(catalog, { projectName: "blog", apiStyle: "laravel" }),
    );
  });
});
