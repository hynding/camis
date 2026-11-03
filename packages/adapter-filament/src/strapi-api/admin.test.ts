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
      ["app/Filament/Pages/UsersPermissionsProviders.php", "Providers"],
      ["app/Filament/Pages/UsersPermissionsEmailTemplates.php", "Email templates"],
      ["app/Filament/Pages/UsersPermissionsAdvancedSettings.php", "Advanced settings"],
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

  // Strapi's Users & Permissions plugin settings are four pages: Roles, Providers, Email templates
  // and Advanced settings, each saving only its own part of the store.
  it("splits the Users & Permissions settings into Strapi's pages", () => {
    expect(strapi.files.some((f) => f.path.endsWith("UsersPermissionsSettings.php"))).toBe(false);
    const pages = [
      ["UsersPermissionsProviders", "Providers", "grant"],
      ["UsersPermissionsEmailTemplates", "Email templates", "email"],
      ["UsersPermissionsAdvancedSettings", "Advanced settings", "advanced"],
    ] as const;
    for (const [cls, title, store] of pages) {
      const source = content(`app/Filament/Pages/${cls}.php`);
      expect(source).toContain(`class ${cls} extends Page`);
      expect(source).toContain(`protected static ?string $title = '${title}';`);
      expect(source).toContain("return auth()->user()?->can('user.update') ?? false;");
      expect(source.match(/StrapiSettings::merge\(/g)).toHaveLength(1);
      expect(source).toContain(
        `StrapiSettings::merge('users-permissions.${store}', $state['${store}']);`,
      );
    }
  });

  it("shows each role's actions as Strapi's Roles page does, with the IR's conditions", async () => {
    const roles = content("app/Support/StrapiRoles.php");
    expect(roles).toContain("'api::article.article' => [");
    expect(roles).toContain("'findOne' => ['article.read'],");
    expect(roles).toContain("'publish' => ['post.publish'],");
    expect(roles).toContain("'note.read' => 'record.ownerId = user.id',");
    expect(roles).toContain("'authenticated' => 'Default role given to authenticated user.',");
    await expect(roles).toMatchFileSnapshot("./__golden__/strapi-api/StrapiRoles.php");
    const resource = content("app/Filament/Resources/Roles/RoleResource.php");
    expect(resource).toContain("public static function canCreate(): bool");
    expect(resource).toContain("CheckboxList::make(");
  });

  // Strapi's Content Manager opens a single type's one entry, or its create form while it has none.
  it("opens a single type's one entry under Single Types", () => {
    const resource = content("app/Filament/Resources/Homepages/HomepageResource.php");
    expect(resource).toContain(
      "protected static string | UnitEnum | null $navigationGroup = StrapiNavigation::SingleTypes;",
    );
    // Its update grant makes the entry, as on the API.
    expect(resource).toContain("return Gate::allows('update', new Homepage());");
    const list = content("app/Filament/Resources/Homepages/Pages/ListHomepages.php");
    expect(list).toContain("public function mount(): void");
    expect(list).toContain(
      "$this->redirect(HomepageResource::getUrl('edit', ['record' => $entry]));",
    );
    expect(list).not.toContain("Create new entry");
    const create = content("app/Filament/Resources/Homepages/Pages/CreateHomepage.php");
    expect(create).toContain(
      "$this->redirect(HomepageResource::getUrl('edit', ['record' => $entry]));",
    );
    // A localized single type opens its default locale.
    expect(content("app/Filament/Resources/Globals/GlobalResource.php")).toContain(
      "->orderByRaw('locale = ? desc', [StrapiLocales::default()])",
    );
    // A reserved-name model keeps its type's name on its pages.
    expect(strapi.files.map((f) => f.path)).toContain(
      "app/Filament/Resources/Globals/Pages/EditGlobal.php",
    );
  });

  // Strapi's Content Manager list searches text and number fields (_q), sorts by any sortable
  // field, starts sorted by the main field (the first string one), and deletes, one or in bulk.
  it("searches, sorts and deletes on a list as Strapi's Content Manager does", () => {
    const table = content("app/Filament/Resources/Posts/Schemas/PostsTable.php");
    expect(table).toContain("TextColumn::make('title')->searchable()->sortable(),");
    expect(table).toContain(
      "TextColumn::make('views')->searchable(query: fn (Builder $query, string $search): Builder => is_numeric($search) ? $query->where('views', $search) : $query->whereRaw('0 = 1'))->sortable(),",
    );
    expect(table).toContain("->defaultSort('title')");
    // A draft-and-publish entry is deleted with every version of it.
    expect(table).toContain(
      "DeleteAction::make()->using(fn (Post $record) => PostResource::deleteEntry($record)),",
    );
    expect(table).toContain(
      "DeleteBulkAction::make()->authorizeIndividualRecords()->using(fn (Collection $records) => $records->each(fn (Post $record) => PostResource::deleteEntry($record))),",
    );
    expect(table).toContain("BulkAction::make('publish')");
    expect(table).toContain("BulkAction::make('unpublish')");
    expect(content("app/Filament/Resources/Posts/PostResource.php")).toContain(
      "public static function deleteEntry(Post $record): void",
    );
    expect(content("app/Filament/Resources/Posts/Pages/EditPost.php")).toContain(
      "DeleteAction::make()->using(fn (Post $record) => PostResource::deleteEntry($record))",
    );
    // A localized draft-and-publish entry is deleted in its locale only.
    expect(content("app/Filament/Resources/Pages/PageResource.php")).toContain(
      "->where('locale', $record->locale)",
    );
    // A type without draft and publish deletes its row; with no string field it sorts by id.
    const plain = content("app/Filament/Resources/Tags/Schemas/TagsTable.php");
    expect(plain).toContain("DeleteAction::make(),");
    expect(plain).toContain("DeleteBulkAction::make()->authorizeIndividualRecords(),");
    expect(plain).not.toContain("BulkAction::make('publish')");
    expect(content("app/Filament/Resources/Tags/Pages/EditTag.php")).toContain(
      "DeleteAction::make(),",
    );
    expect(content("app/Filament/Resources/Notes/Schemas/NotesTable.php")).toContain(
      "->defaultSort('record_id')",
    );
    // json is neither searched nor sorted.
    expect(content("app/Filament/Resources/Notes/Schemas/NotesTable.php")).toContain(
      "TextColumn::make('tags'),",
    );
  });

  // Bulk delete is offered only to a role that may delete: a policy without deleteAny would let
  // Filament offer it to everyone.
  it("gives each policy a deleteAny held by the delete grant", () => {
    const policy = content("app/Policies/PostPolicy.php");
    expect(policy).toMatch(/public function deleteAny\(\??User \$user\): bool/);
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
