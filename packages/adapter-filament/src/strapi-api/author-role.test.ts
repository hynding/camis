import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { authorRoleBundle } from "./__fixtures__/author-role";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi's Author role: it may create entries, and read, edit, delete and publish only the ones
// it created (admin::is-creator), while the Editor may do all of it to every entry.
describe("an admin role limited to the entries its accounts created", () => {
  const result = filamentAdapter.generate(authorRoleBundle, {
    projectName: "press",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("generates with no gap about the condition", () => {
    expect(
      result.gaps.gaps.filter((g) =>
        ["conditionContext", "conditionConflict", "adminListScope"].includes(g.feature),
      ),
    ).toEqual([]);
  });

  it("lets the Editor through outright and holds the Author to the entries it created", () => {
    const policy = content("app/Policies/StoryPolicy.php");
    const update = policy.slice(policy.indexOf("public function update("));
    expect(update).toContain("if ($user->hasAnyRole(['editor'])) {");
    expect(update).toContain(
      "'record.createdBy' => $user instanceof AdminUser ? $record->created_by_id : null,",
    );
    expect(update).toContain('Ring1::var($data, "record.createdBy")');
  });

  // The content API's users hold Story.read outright; the Author's condition is not theirs.
  it("leaves an API role's grant on the same action unconditional", () => {
    const policy = content("app/Policies/StoryPolicy.php");
    const view = policy.slice(policy.indexOf("public function view("));
    expect(view).toContain("if ($user->hasAnyRole(['authenticated', 'editor'])) {");
    expect(content("app/Models/Story.php")).toMatch(
      /public function scopeForUser\(Builder \$q, \?User \$user\): Builder\n {4}\{\n {8}return \$q;\n {4}\}/,
    );
  });

  it("lists to an Author only the entries it created", () => {
    for (const [model, resource] of [
      ["Story", "app/Filament/Resources/Stories/StoryResource.php"],
      ["Memo", "app/Filament/Resources/Memos/MemoResource.php"],
    ] as const) {
      const php = content(`app/Models/${model}.php`);
      expect(php).toContain("public function scopeForAdmin(Builder $q,");
      expect(php).toContain("$q->where('created_by_id', '=', $user->id);");
      expect(content(resource)).toContain("->forAdmin(Filament::auth()->user());");
      expect(content(resource)).toContain("use Filament\\Facades\\Filament;");
    }
    expect(content("app/Filament/Resources/Memos/MemoResource.php")).toContain(
      "return parent::getEloquentQuery()->forAdmin(Filament::auth()->user());",
    );
  });

  it("leaves a project whose admin roles read outright unscoped", () => {
    const strapi = filamentAdapter.generate(strapiApiBundle, {
      projectName: "oyl",
      apiStyle: "strapi",
    });
    expect(strapi.files.some((f) => f.content.includes("scopeForAdmin"))).toBe(false);
    expect(strapi.files.some((f) => f.content.includes("forAdmin("))).toBe(false);
  });

  // Only the Strapi API style records who created an entry.
  it("reports the condition where the target records no creator", () => {
    const plain = filamentAdapter.generate(authorRoleBundle, { projectName: "press" });
    expect(plain.gaps.gaps.filter((g) => g.feature === "conditionContext").length).toBeGreaterThan(
      0,
    );
  });
});
