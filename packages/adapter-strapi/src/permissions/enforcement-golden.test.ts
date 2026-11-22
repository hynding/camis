import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { ownershipBundle } from "../__fixtures__/ownership";

const file = (
  result: ReturnType<typeof strapiAdapter.generate>,
  path: string,
): string | undefined => result.files.find((f) => f.path === path)?.content;

/** The file's content, failing rather than letting a snapshot record a file never emitted. */
const emitted = (result: ReturnType<typeof strapiAdapter.generate>, path: string): string => {
  const content = file(result, path);
  expect(content, path).toBeDefined();
  return content!;
};

describe("content API enforcement golden", () => {
  const result = strapiAdapter.generate(ownershipBundle, { projectName: "notes" });

  it("api-conditions.ts (the pure decisions and the project's rules) matches the golden", async () => {
    await expect(emitted(result, "src/permissions/api-conditions.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/api-conditions.ts.txt",
    );
  });
  it("api-controller.ts (the core controller wrapper) matches the golden", async () => {
    await expect(emitted(result, "src/permissions/api-controller.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/api-controller.ts.txt",
    );
  });
  it("api-uploads.ts (the upload API's decisions) matches the golden", async () => {
    await expect(emitted(result, "src/permissions/api-uploads.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/api-uploads.ts.txt",
    );
  });
  it("api-upload-controller.ts (the upload controller wrapper) matches the golden", async () => {
    await expect(emitted(result, "src/permissions/api-upload-controller.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/api-upload-controller.ts.txt",
    );
  });
  it("the upload extension records the uploader and wraps the plugin's controller", async () => {
    await expect(emitted(result, "src/extensions/upload/strapi-server.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/upload.strapi-server.ts.txt",
    );
  });
  it("an enforced type's controller wraps the core controller with its rules", async () => {
    await expect(emitted(result, "src/api/note/controllers/note.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/note.controller.ts.txt",
    );
  });
  it("a type that only reaches a conditioned type gets the same wrapper", async () => {
    await expect(emitted(result, "src/api/tag/controllers/tag.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/tag.controller.ts.txt",
    );
  });
  it("a type with no rules of its own that a relation write reaches gets the same wrapper", async () => {
    await expect(emitted(result, "src/api/category/controllers/category.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/category.controller.ts.txt",
    );
  });
  it("a single type a restricted role writes gets the body check over Strapi's single type controller", async () => {
    await expect(emitted(result, "src/api/front/controllers/front.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/front.controller.ts.txt",
    );
  });
  it("every enforcement file carries the generated marker", () => {
    for (const path of [
      "src/permissions/api-conditions.ts",
      "src/permissions/api-controller.ts",
      "src/permissions/api-uploads.ts",
      "src/permissions/api-upload-controller.ts",
      "src/extensions/upload/strapi-server.ts",
      "src/api/note/controllers/note.ts",
      "src/api/tag/controllers/tag.ts",
      "src/api/category/controllers/category.ts",
    ]) {
      expect(file(result, path)?.startsWith("// @camis:generated")).toBe(true);
    }
  });
  it("api-roles.json matches the golden", async () => {
    await expect(file(result, "src/permissions/api-roles.json")).toMatchFileSnapshot(
      "../__golden__/ownership/api-roles.json",
    );
  });
  it("bootstrap index.ts matches the golden", async () => {
    await expect(file(result, "src/index.ts")).toMatchFileSnapshot(
      "../__golden__/ownership/index.ts.txt",
    );
  });
  it("reports the admin-panel copies' conditions and the user.find of roles that write the owner, and nothing open", () => {
    expect(
      result.gaps.gaps.map(
        (g) => `${g.severity} ${g.feature} ${g.location.contentType}.${g.location.rule}`,
      ),
    ).toEqual([
      "downgrade conditionContext Note.public",
      "downgrade conditionContext Note.member",
      "downgrade conditionContext Note.contributor",
      "downgrade conditionContext Note.drafter",
      "downgrade conditionContext Note.reviewer",
      "downgrade userRelationWrite Note.reviewer",
      "downgrade userRelationWrite Note.manager",
    ]);
  });
  // Strapi links a stored file through a media field with no upload permission, so the media
  // checks run without file grants; the extension still checks the upload API's reads (a custom
  // API token may hold their scope), but records no uploader.
  it("with no role writing files, tables the media checks and records no uploader", () => {
    const noFiles = {
      ...ownershipBundle,
      roles: ownershipBundle.roles.map((r) => ({
        ...r,
        grants: r.grants.filter((g) => g.contentType !== "File"),
      })),
    };
    const files = strapiAdapter.generate(noFiles, { projectName: "notes" });
    expect(file(files, "src/extensions/upload/strapi-server.ts")).toContain("enforcedUpload");
    expect(file(files, "src/extensions/upload/strapi-server.ts")).not.toContain("camisUploader");
    expect(emitted(files, "src/permissions/api-conditions.ts")).toContain(
      "uploaderRecorded: false,",
    );
    expect(file(files, "src/permissions/api-upload-controller.ts")).toBeDefined();
  });
  it("regeneration is idempotent", () => {
    expect(strapiAdapter.generate(ownershipBundle, { projectName: "notes" })).toEqual(result);
  });
});
