import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { authorRoleBundle } from "./__fixtures__/author-role";
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

  it("shows each role's actions as Strapi's Roles page does, with the IR's conditions in words", async () => {
    const roles = content("app/Support/StrapiRoles.php");
    expect(roles).toContain("'api::article.article' => [");
    expect(roles).toContain("'findOne' => ['article.read'],");
    expect(roles).toContain("'publish' => ['post.publish'],");
    expect(roles).toContain("'note.read' => 'Owner id is the user\\'s id',");
    expect(roles).toContain("'authenticated' => 'Default role given to authenticated user.',");
    await expect(roles).toMatchFileSnapshot("./__golden__/strapi-api/StrapiRoles.php");
    const resource = content("app/Filament/Resources/Roles/RoleResource.php");
    expect(resource).toContain("public static function getCreateAuthorizationResponse(): Response");
    expect(resource).toContain("CheckboxList::make(");
  });

  it("names Strapi's is-creator condition as Strapi's admin does", () => {
    const roles = filamentAdapter
      .generate(authorRoleBundle, { projectName: "press", apiStyle: "strapi" })
      .files.find((f) => f.path === "app/Support/StrapiRoles.php")!.content;
    expect(roles).toContain("'story.read' => 'Is creator',");
  });

  // Strapi's Content Manager opens a single type's one entry, or its create form while it has none.
  it("opens a single type's one entry under Single Types", () => {
    const resource = content("app/Filament/Resources/Homepages/HomepageResource.php");
    expect(resource).toContain(
      "protected static string | UnitEnum | null $navigationGroup = StrapiNavigation::SingleTypes;",
    );
    // Its update grant makes the entry, as on the API.
    expect(resource).toContain("return Gate::inspect('update', new Homepage());");
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
    // The list starts sorted by the main field, as its view configuration says (Strapi's default).
    expect(table).toContain("StrapiContentManager::table($table, PostResource::CONTENT_MANAGER");
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
    expect(content("app/Filament/Resources/Notes/NoteResource.php")).toContain(
      "'recordId' => ['type' => 'string', 'list' => true, 'sort' => true",
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
    expect(policy).toMatch(/public function deleteAny\(User\|AdminUser(\|null)? \$user\): bool/);
  });

  // Strapi's list filters by its fields, relations, timestamps and creators (not json, media,
  // richtext, blocks or components), each as its type compares.
  it("filters a list by its fields and relations as Strapi's Content Manager does", () => {
    const table = content("app/Filament/Resources/Books/Schemas/BooksTable.php");
    expect(table).toContain("'id' => NumberConstraint::make('id'),");
    expect(table).toContain("'title' => TextConstraint::make('title'),");
    expect(table).toContain("'pages' => NumberConstraint::make('pages')->nullable(),");
    expect(table).toContain("'inStock' => BooleanConstraint::make('in_stock')->nullable(),");
    expect(table).toContain("'publishedOn' => DateConstraint::make('published_on')->nullable(),");
    expect(table).toContain(
      "'genres' => RelationshipConstraint::make('genres')->multiple()->selectable(IsRelatedToOperator::make()->titleAttribute('name')->searchable()->multiple()),",
    );
    // A draft-and-publish target offers its drafts, which links hold.
    expect(table).toContain(
      "'topic' => RelationshipConstraint::make('topic')->selectable(IsRelatedToOperator::make()->titleAttribute('name')->modifyRelationshipQueryUsing(fn ($query) => $query->whereNull('published_at'))->searchable()->multiple()),",
    );
    expect(table).toContain("'createdAt' => DateConstraint::make('created_at'),");
    expect(table).toContain("'updatedBy' => RelationshipConstraint::make('updatedBy')");
    expect(table).not.toMatch(/'price' => \w+Constraint/);
    expect(table).not.toMatch(/'cover' => \w+Constraint/);
    const submissions = content("app/Filament/Resources/Submissions/Schemas/SubmissionsTable.php");
    expect(submissions).toContain(
      "'kind' => SelectConstraint::make('kind')->options(['alpha' => 'alpha', 'beta' => 'beta'])->multiple()->nullable(),",
    );
  });

  // Strapi duplicates an entry from its list row or its edit page; an entry with a uid or unique
  // field, or a relation the copy would take, opens the create form filled with it instead.
  it("duplicates an entry as Strapi's Content Manager does", () => {
    const posts = content("app/Filament/Resources/Posts/Schemas/PostsTable.php");
    expect(posts).toContain("Action::make('duplicate')");
    expect(posts).toContain("$copy = PostResource::duplicate($record);");
    const post = content("app/Filament/Resources/Posts/PostResource.php");
    expect(post).toContain("public const PROHIBITED_CLONING_FIELDS = [];");
    expect(post).toContain("return StrapiDocuments::duplicate($record, PostSerializer::class);");
    expect(content("app/Filament/Resources/Posts/Pages/EditPost.php")).toContain(
      "Action::make('duplicate')",
    );
    expect(content("app/Filament/Resources/Submissions/SubmissionResource.php")).toContain(
      "public const PROHIBITED_CLONING_FIELDS = ['handle'];",
    );
    expect(content("app/Filament/Resources/Notes/NoteResource.php")).toContain(
      "public const PROHIBITED_CLONING_FIELDS = ['recordId'];",
    );
    const submissions = content("app/Filament/Resources/Submissions/Schemas/SubmissionsTable.php");
    expect(submissions).toContain(
      "SubmissionResource::getUrl('create', ['duplicate' => $record->getKey()])",
    );
    const create = content("app/Filament/Resources/Submissions/Pages/CreateSubmission.php");
    expect(create).toContain("StrapiContentManager::fillWith($this->form, $source,");
    // A single type has one entry, which Strapi does not duplicate.
    expect(content("app/Filament/Resources/Homepages/Pages/EditHomepage.php")).not.toContain(
      "duplicate",
    );
    expect(content("app/Support/StrapiDocuments.php")).toContain(
      "public static function duplicate(Model $from, string $serializer): Model",
    );
  });

  // Strapi's uid field: made from its target field while the entry is created, regenerated on
  // demand, and checked against other documents' drafts.
  it("makes a uid from its target field as Strapi's Content Manager does", () => {
    const form = content("app/Filament/Resources/Submissions/Schemas/SubmissionForm.php");
    expect(form).toContain(
      "$set('handle', StrapiUid::generate(Submission::class, 'handle', $get('title'), null, 'submission'));",
    );
    expect(form).toContain("->suffixAction(Action::make('regenerate')");
    expect(form).toContain(
      "->rule(fn (Get $get, ?Model $record): \\Closure => StrapiUid::rule(Submission::class, 'handle', null, $record))",
    );
    expect(content("app/Support/StrapiUid.php")).toContain(
      "public static function slugify(string $value): string",
    );
  });

  // Strapi's createdBy and updatedBy: columns every content type's table has, set by admin writes.
  it("records who made and last changed an entry, as Strapi's createdBy and updatedBy", () => {
    const migration = strapi.files.find((f) => /create_posts_table\.php$/.test(f.path))!.content;
    expect(migration).toContain(
      "$table->foreignId('created_by_id')->nullable()->constrained('admin_users')->nullOnDelete();",
    );
    expect(migration).toContain(
      "$table->foreignId('updated_by_id')->nullable()->constrained('admin_users')->nullOnDelete();",
    );
    expect(content("app/Models/Post.php")).toContain("use HasCreatorFields;");
    expect(content("app/Models/Concerns/HasCreatorFields.php")).toContain(
      "public function createdBy(): BelongsTo",
    );
    // Strapi's createdBy is an admin account, never an API user.
    expect(content("app/Models/Concerns/HasCreatorFields.php")).toContain(
      "return $this->belongsTo(AdminUser::class, 'created_by_id');",
    );
    expect(content("app/Filament/Resources/Posts/Schemas/PostsTable.php")).toContain(
      "'createdBy' => TextColumn::make('createdBy.firstname')->sortable(),",
    );
  });

  // Strapi's "Configure the view": a page per content type whose settings, list columns and edit
  // fields the list and form are laid out by, attribute by attribute in schema order.
  it("lays the list and form out as Strapi's view configuration says", async () => {
    const resource = content("app/Filament/Resources/Books/BookResource.php");
    expect(resource).toContain("'uid' => 'api::book.book',");
    expect(resource).toContain(
      "'price' => ['type' => 'component', 'list' => false, 'sort' => false, 'edit' => true, 'size' => 12, 'resizable' => false],",
    );
    expect(resource).toContain(
      "'inStock' => ['type' => 'boolean', 'list' => true, 'sort' => true, 'edit' => true, 'size' => 4, 'resizable' => true],",
    );
    expect(resource).toContain("'configure' => ConfigureBooksView::route('/configure-the-view'),");
    expect(resource).toContain("return auth()->user()?->can('book.update') ?? false;");
    const form = content("app/Filament/Resources/Books/Schemas/BookForm.php");
    expect(form).toContain(
      "return StrapiContentManager::form($schema, BookResource::CONTENT_MANAGER, [",
    );
    // An embedded component's columns are edited together, under the component's attribute.
    expect(form).toMatch(
      /'price' => \[\n\s+TextInput::make\('price_minor'\)->numeric\(\),\n\s+TextInput::make\('price_currency'\),/,
    );
    expect(content("app/Filament/Resources/Books/Pages/ListBooks.php")).toContain(
      "Action::make('configure')->label('Configure the view')",
    );
    expect(content("app/Filament/Resources/Books/Pages/ConfigureBooksView.php")).toContain(
      "class ConfigureBooksView extends ConfigureView",
    );
    // A single type configures its edit view from its edit page.
    expect(content("app/Filament/Resources/Homepages/Pages/EditHomepage.php")).toContain(
      "Action::make('configure')",
    );
    // Settings resources keep their plain list.
    expect(content("app/Filament/Resources/Locales/Schemas/LocalesTable.php")).not.toContain(
      "StrapiContentManager",
    );
    await expect(content("app/Support/StrapiContentManager.php")).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiContentManager.php",
    );
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
