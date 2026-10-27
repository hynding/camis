import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// The Filament admin laid out as Strapi's: the Content Manager's collection types by display name,
// the Media Library, then Settings in Strapi's order, with a Roles page showing each role's
// users-permissions actions as the IR grants them.
describe("the Strapi-like admin", () => {
  const strapi = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => strapi.files.find((f) => f.path === p)!.content;

  it("groups the navigation as Strapi's menu does", async () => {
    const navigation = content("app/Filament/StrapiNavigation.php");
    expect(navigation.indexOf("case CollectionTypes")).toBeLessThan(
      navigation.indexOf("case Settings"),
    );
    expect(navigation).toContain("self::CollectionTypes => 'Collection Types',");
    await expect(navigation).toMatchFileSnapshot("./__golden__/strapi-api/StrapiNavigation.php");
  });

  it("lists each collection type under its Strapi display name, alphabetically", () => {
    const article = content("app/Filament/Resources/Articles/ArticleResource.php");
    expect(article).toContain(
      "protected static string | UnitEnum | null $navigationGroup = StrapiNavigation::CollectionTypes;",
    );
    expect(article).toContain("protected static ?string $navigationLabel = 'Article';");
    const sort = (p: string) => Number(/\$navigationSort = (\d+);/.exec(content(p))?.[1]);
    expect(sort("app/Filament/Resources/Activities/ActivityResource.php")).toBeLessThan(
      sort("app/Filament/Resources/Articles/ArticleResource.php"),
    );
    expect(sort("app/Filament/Resources/Transactions/TransactionResource.php")).toBeLessThan(
      sort("app/Filament/Resources/Users/UserResource.php"),
    );
    expect(content("app/Filament/Resources/Users/UserResource.php")).toContain(
      "protected static ?string $navigationLabel = 'User';",
    );
  });

  it("offers Strapi's Create new entry on a list", () => {
    expect(content("app/Filament/Resources/Articles/Pages/ListArticles.php")).toContain(
      "CreateAction::make()->label('Create new entry'),",
    );
  });

  it("orders Settings as Strapi does, the locales as Internationalization", () => {
    const settings = [
      ["app/Filament/Resources/ApiTokens/ApiTokenResource.php", "API Tokens"],
      ["app/Filament/Resources/Locales/LocaleResource.php", "Internationalization"],
      ["app/Filament/Resources/TransferTokens/TransferTokenResource.php", "Transfer Tokens"],
      ["app/Filament/Resources/Webhooks/WebhookResource.php", "Webhooks"],
      ["app/Filament/Pages/DataTransfer.php", "Data transfer"],
      ["app/Filament/Resources/Roles/RoleResource.php", "Roles"],
      ["app/Filament/Pages/UsersPermissionsSettings.php", "Users & Permissions"],
    ] as const;
    const sorts = settings.map(([path, label]) => {
      const source = content(path);
      expect(source).toContain(
        "protected static string | UnitEnum | null $navigationGroup = StrapiNavigation::Settings;",
      );
      expect(source).toContain(`protected static ?string $navigationLabel = '${label}';`);
      return Number(/\$navigationSort = (\d+);/.exec(source)?.[1]);
    });
    expect(sorts).toEqual([...sorts].sort((a, b) => a - b));
  });

  it("shows each role's actions as Strapi's Roles page does, with the IR's conditions", async () => {
    const roles = content("app/Support/StrapiRoles.php");
    expect(roles).toContain("'api::article.article' => [");
    expect(roles).toContain("'findOne' => 'article.read',");
    expect(roles).toContain("'publish' => 'post.publish',");
    expect(roles).toContain("'note.read' => 'record.ownerId = user.id',");
    expect(roles).toContain(
      "'authenticated' => 'Default role given to authenticated user.',",
    );
    await expect(roles).toMatchFileSnapshot("./__golden__/strapi-api/StrapiRoles.php");
    const resource = content("app/Filament/Resources/Roles/RoleResource.php");
    expect(resource).toContain("public static function canCreate(): bool");
    expect(resource).toContain("CheckboxList::make(");
  });

  it("leaves the Laravel API style's admin as it was", () => {
    const laravel = filamentAdapter.generate(strapiApiBundle, { projectName: "oyl" });
    expect(laravel.files.some((f) => f.path === "app/Filament/StrapiNavigation.php")).toBe(false);
    expect(
      laravel.files.find((f) => f.path === "app/Filament/Resources/Articles/ArticleResource.php")
        ?.content,
    ).not.toContain("StrapiNavigation");
  });
});
