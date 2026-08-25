import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";
import { permissionsBundle } from "./__fixtures__/permissions";

const bundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [{ type: "string", name: "title", required: true }],
      },
      {
        name: "Tag",
        kind: "collection",
        fields: [{ type: "string", name: "label", required: true }],
      },
    ],
    components: [],
  },
  roles: [],
};

describe("filamentAdapter", () => {
  const result = filamentAdapter.generate(bundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);

  it("emits a model, an ordinal migration, and a resource set per content type", () => {
    expect(paths).toContain("app/Models/Article.php");
    expect(paths).toContain("database/migrations/0001_01_02_000001_create_articles_table.php");
    expect(paths).toContain("database/migrations/0001_01_02_000002_create_tags_table.php");
    expect(paths).toContain("app/Filament/Resources/Articles/ArticleResource.php");
  });
  it("builds a manifest and an empty gap report (scalars only)", () => {
    expect(result.manifest.files.length).toBe(result.files.length);
    expect(result.gaps).toEqual({ target: "filament", gaps: [] });
  });
  it("is deterministic / idempotent", () => {
    expect(filamentAdapter.generate(bundle, { projectName: "blog" })).toEqual(result);
  });
});

const relBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          {
            type: "relation",
            name: "author",
            relationKind: "manyToOne",
            target: "Author",
            inverse: "articles",
          },
          {
            type: "relation",
            name: "tags",
            relationKind: "manyToMany",
            target: "Tag",
            inverse: "articles",
          },
          { type: "component", name: "seo", component: "Seo", repeatable: false },
        ],
      },
      {
        name: "Author",
        kind: "collection",
        fields: [{ type: "string", name: "name", required: true }],
      },
      {
        name: "Tag",
        kind: "collection",
        fields: [{ type: "string", name: "label", required: true }],
      },
    ],
    components: [{ name: "Seo", fields: [{ type: "string", name: "metaTitle" }] }],
  },
  roles: [],
};

describe("filamentAdapter relations + gaps", () => {
  const result = filamentAdapter.generate(relBundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits a pivot migration after the content-type migrations", () => {
    expect(paths).toContain("database/migrations/0001_01_02_000004_create_article_tag_table.php");
  });
  it("injects the author_id FK into the articles migration", () => {
    const mig = result.files.find((f) => f.path.endsWith("create_articles_table.php"))!.content;
    expect(mig).toContain("$table->foreignId('author_id')->nullable()->constrained('authors');");
  });
  it("flattens the component field into embedded columns instead of a capability gap", () => {
    expect(result.gaps.gaps).toEqual([]);
    const mig = result.files.find((f) => f.path.endsWith("create_articles_table.php"))!.content;
    expect(mig).toContain("$table->string('seo_meta_title')->nullable();");
  });
});

describe("filamentAdapter permissions", () => {
  const result = filamentAdapter.generate(permissionsBundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits the seeder, policy, and Ring1 support file", () => {
    expect(paths).toContain("database/seeders/RolePermissionSeeder.php");
    expect(paths).toContain("app/Policies/ArticlePolicy.php");
    expect(paths).toContain("app/Support/Ring1.php");
  });
  it("has no gaps for the user.*/record.* fixture", () => {
    expect(result.gaps.gaps).toEqual([]);
  });
});

describe("filamentAdapter AI fields", () => {
  it("emits the AI provider + observer and marks the model observed for an AI content type", () => {
    const r = filamentAdapter.generate(
      {
        document: {
          version: 1,
          contentTypes: [
            {
              name: "Article",
              kind: "collection",
              fields: [
                { type: "text", name: "body" },
                {
                  type: "text",
                  name: "summary",
                  ai: { prompt: "Sum {{body}}", trigger: "onCreate" },
                },
              ],
            },
          ],
          components: [],
        },
        roles: [],
      } as never,
      { projectName: "blog" },
    );
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("app/Ai/Provider.php");
    expect(paths).toContain("app/Observers/ArticleObserver.php");
    expect(r.files.find((f) => f.path === "app/Models/Article.php")!.content).toContain(
      "ObservedBy",
    );
  });
  it("emits no AI files when no content type has an ai field", () => {
    const r = filamentAdapter.generate(
      {
        document: {
          version: 1,
          contentTypes: [
            { name: "Article", kind: "collection", fields: [{ type: "text", name: "body" }] },
          ],
          components: [],
        },
        roles: [],
      } as never,
      { projectName: "blog" },
    );
    expect(r.files.some((f) => f.path === "app/Ai/Provider.php")).toBe(false);
  });
  it("gaps a content type with BOTH a hook and an ai field (observer collision)", () => {
    const r = filamentAdapter.generate(
      {
        document: {
          version: 1,
          hooks: [
            {
              name: "Enrich",
              trigger: "onPublish",
              contentType: "Article",
              input: [{ name: "body", type: "text" }],
              output: [{ name: "summary", type: "text" }],
            },
          ],
          contentTypes: [
            {
              name: "Article",
              kind: "collection",
              fields: [
                { type: "text", name: "body" },
                {
                  type: "text",
                  name: "summary",
                  ai: { prompt: "Sum {{body}}", trigger: "onCreate" },
                },
              ],
            },
          ],
          components: [],
        },
        roles: [],
      } as never,
      { projectName: "blog" },
    );
    expect(
      r.gaps.gaps.some(
        (g) => g.feature === "aiHookCollision" && g.location.contentType === "Article",
      ),
    ).toBe(true);
    expect(r.files.filter((f) => f.path === "app/Observers/ArticleObserver.php")).toHaveLength(1);
  });
});

describe("builtin user", () => {
  const docWithBuiltinUser = {
    version: 1 as const,
    contentTypes: [
      {
        name: "Note",
        kind: "collection" as const,
        fields: [
          { type: "text" as const, name: "text" },
          {
            type: "relation" as const,
            name: "owner",
            relationKind: "manyToOne" as const,
            target: "User",
          },
        ],
      },
      {
        name: "User",
        kind: "collection" as const,
        builtin: "user" as const,
        fields: [
          { type: "string" as const, name: "username", required: true, unique: true },
          { type: "email" as const, name: "email", required: true },
        ],
      },
    ],
    components: [],
  };

  it("maps builtin User relations onto the stock Laravel User without emitting user files", () => {
    const result = filamentAdapter.generate(
      { document: docWithBuiltinUser, roles: [] },
      { projectName: "t" },
    );
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain("app/Models/User.php");
    expect(paths.some((p) => p.includes("create_users_table"))).toBe(false);
    expect(paths.some((p) => p.startsWith("app/Filament/Resources/Users/"))).toBe(false);
    const note = result.files.find((f) => f.path === "app/Models/Note.php")!;
    expect(note.content).toContain("$this->belongsTo(User::class, 'owner_id')");
    const migration = result.files.find((f) => f.path.includes("create_notes_table"))!;
    expect(migration.content).toContain("->constrained('users')");
    expect(migration.path).toBe("database/migrations/0001_01_02_000001_create_notes_table.php");
    expect(result.gaps.gaps).toEqual([]);
  });
});

describe("component fields — embedded columns", () => {
  const moneyDoc = {
    version: 1 as const,
    contentTypes: [
      {
        name: "Transaction",
        kind: "collection" as const,
        fields: [
          { type: "string" as const, name: "category" },
          {
            type: "component" as const,
            name: "amount",
            component: "Money",
            repeatable: false,
          },
        ],
      },
    ],
    components: [
      {
        name: "Money",
        fields: [
          { type: "bigInteger" as const, name: "minor", required: true },
          { type: "string" as const, name: "currency", required: true },
          { type: "integer" as const, name: "exponent", default: 2 },
        ],
      },
    ],
  };

  it("flattens a non-repeatable component into prefixed columns across migration/model/form", () => {
    const result = filamentAdapter.generate(
      { document: moneyDoc, roles: [] },
      { projectName: "t" },
    );
    expect(result.gaps.gaps).toEqual([]);
    const migration = result.files.find((f) => f.path.includes("create_transactions_table"))!;
    expect(migration.content).toContain("$table->bigInteger('amount_minor')");
    expect(migration.content).toContain("$table->string('amount_currency')");
    expect(migration.content).toContain(
      "$table->integer('amount_exponent')->nullable()->default(2)",
    );
    const model = result.files.find((f) => f.path === "app/Models/Transaction.php")!;
    expect(model.content).toContain("'amount_minor',");
    expect(model.content).toContain("'amount_currency',");
    const form = result.files.find((f) => f.path.endsWith("Schemas/TransactionForm.php"))!;
    expect(form.content).toContain("TextInput::make('amount_minor')->numeric()->required()");
    const table = result.files.find((f) => f.path.endsWith("Schemas/TransactionsTable.php"))!;
    expect(table.content).toContain("TextColumn::make('amount_currency')");
  });
});

describe("component fields — repeatable child tables", () => {
  const sessionDoc = {
    version: 1 as const,
    contentTypes: [
      {
        name: "ActivitySession",
        kind: "collection" as const,
        fields: [
          { type: "dateTime" as const, name: "occurredAt", required: true },
          {
            type: "component" as const,
            name: "quantities",
            component: "Quantity",
            repeatable: true,
          },
        ],
      },
    ],
    components: [
      {
        name: "Quantity",
        fields: [
          { type: "decimal" as const, name: "amount", required: true },
          { type: "string" as const, name: "unit", required: true },
        ],
      },
    ],
  };

  it("emits a child table, child model, parent HasMany, and a Repeater form", () => {
    const result = filamentAdapter.generate(
      { document: sessionDoc, roles: [] },
      { projectName: "t" },
    );
    expect(result.gaps.gaps).toEqual([]);
    const paths = result.files.map((f) => f.path);

    const childMig = result.files.find((f) =>
      f.path.endsWith("create_activity_sessions_quantities_table.php"),
    )!;
    expect(childMig).toBeDefined();
    expect(childMig.content).toContain(
      "$table->foreignId('activity_session_id')->constrained('activity_sessions')->cascadeOnDelete();",
    );
    expect(childMig.content).toContain("$table->decimal('amount');");
    expect(childMig.path).toBe(
      "database/migrations/0001_01_02_000002_create_activity_sessions_quantities_table.php",
    );

    expect(paths).toContain("app/Models/ActivitySessionQuantities.php");
    const childModel = result.files.find(
      (f) => f.path === "app/Models/ActivitySessionQuantities.php",
    )!;
    expect(childModel.content).toContain("protected $table = 'activity_sessions_quantities';");
    expect(childModel.content).toContain("'amount',");

    const parentModel = result.files.find((f) => f.path === "app/Models/ActivitySession.php")!;
    expect(parentModel.content).toContain("public function quantities(): HasMany");
    expect(parentModel.content).toContain(
      "return $this->hasMany(ActivitySessionQuantities::class, 'activity_session_id');",
    );

    const form = result.files.find((f) => f.path.endsWith("Schemas/ActivitySessionForm.php"))!;
    expect(form.content).toContain("Repeater::make('quantities')");
    expect(form.content).toContain("->relationship()");
    expect(form.content).toContain("TextInput::make('amount')->numeric()->required()");
  });
});

describe("DEPLOY.md", () => {
  it("is emitted with env-driven DB selection and migrate/seed steps", () => {
    const result = filamentAdapter.generate(bundle, { projectName: "blog" });
    const deploy = result.files.find((f) => f.path === "DEPLOY.md");
    expect(deploy).toBeDefined();
    expect(deploy!.content).toContain("DB_CONNECTION");
    expect(deploy!.content).toContain("php artisan migrate");
    expect(deploy!.content).toContain("RolePermissionSeeder");
    expect(deploy!.content).toContain("public/");
  });
});

describe("Filament v5 resource compatibility", () => {
  it("declares navigationIcon with the v5 BackedEnum union type", () => {
    const result = filamentAdapter.generate(bundle, { projectName: "blog" });
    const resource = result.files.find((f) => f.path.endsWith("ArticleResource.php"))!;
    expect(resource.content).toContain(
      "protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-rectangle-stack';",
    );
    expect(resource.content).toContain("use BackedEnum;");
  });
});
