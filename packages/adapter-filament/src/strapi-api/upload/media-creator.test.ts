import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";
import { authorRoleBundle } from "../__fixtures__/author-role";

// Strapi records the admin account that uploaded a file, and its default Author reads and changes
// only the files it uploaded (admin::is-creator on the media library's actions).
const result = filamentAdapter.generate(authorRoleBundle, {
  projectName: "press",
  apiStyle: "strapi",
});
const content = (path: string): string => result.files.find((f) => f.path === path)!.content;

describe("the media library's creator", () => {
  it("records who uploaded a file and who changed it last", () => {
    const migration = content("database/migrations/0001_01_02_000000_create_files_table.php");
    expect(migration).toContain(
      "$table->foreignId('created_by_id')->nullable()->constrained('admin_users')->nullOnDelete();",
    );
    expect(migration).toContain(
      "$table->foreignId('updated_by_id')->nullable()->constrained('admin_users')->nullOnDelete();",
    );
    expect(content("app/Models/File.php")).toContain("    use HasCreatorFields;");
  });

  it("holds an Author to the files it uploaded", () => {
    expect(content("app/Policies/FilePolicy.php")).toContain(
      "'record.createdBy' => $user instanceof AdminUser ? $record->created_by_id : null,",
    );
    expect(content("app/Models/File.php")).toContain("public function scopeForAdmin(");
    expect(content("app/Filament/Resources/Files/FileResource.php")).toContain(
      "return parent::getEloquentQuery()->forAdmin(Filament::auth()->user());",
    );
  });

  it("reports nothing it cannot serve", () => {
    expect(result.gaps.gaps.filter((g) => g.location.contentType === "File")).toEqual([]);
  });
});
