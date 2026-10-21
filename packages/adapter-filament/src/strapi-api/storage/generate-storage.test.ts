import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { filamentAdapter } from "../../generate";
import { catalog } from "../../__fixtures__/catalog";
import { hooksBundle } from "../../__fixtures__/hooks";
import { strapiApiBundle } from "../__fixtures__/strapi-api";
import { storageBundle } from "./__fixtures__/storage";
import { expectedSchema } from "./schema-check";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const result = filamentAdapter.generate(storageBundle, {
  projectName: "oyl",
  apiStyle: "strapi",
  storageLayout: "strapi",
});
const paths = result.files.map((f) => f.path);
const content = (p: string): string => {
  const found = result.files.find((f) => f.path === p);
  if (!found) throw new Error(`no generated file at ${p}`);
  return found.content;
};

describe("filamentAdapter storageLayout strapi — file set", () => {
  it("file listing golden", async () => {
    await expect(
      result.files
        .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
        .sort()
        .join("\n"),
    ).toMatchFileSnapshot("../../__golden__/storage/file-listing.txt");
  });

  // Strapi owns the schema, the admin panel and the Spatie-free authorization model, so every
  // Laravel-layout artifact that would fight it must be absent — not merely unused.
  it("emits nothing Strapi owns: no migrations, no Filament resources, no permission seeder", () => {
    expect(paths.filter((p) => p.startsWith("database/migrations/"))).toEqual([]);
    expect(paths.filter((p) => p.startsWith("app/Filament/"))).toEqual([]);
    expect(paths).not.toContain("database/seeders/RolePermissionSeeder.php");
    // Phase 16's username migration belongs to the Sanctum `users` table, not Strapi's up_users.
    expect(paths.filter((p) => p.includes("add_username_to_users_table"))).toEqual([]);
  });

  it("emits the storage layout's models, runtime, controllers, routes and schema check", () => {
    for (const p of [
      "app/Casts/StrapiDateTime.php",
      "app/Support/StrapiRows.php",
      "app/Support/StrapiComponents.php",
      "app/Support/StrapiComponentAttributes.php",
      "app/Http/Middleware/StrapiJwtGuard.php",
      "app/Http/Middleware/StrapiErrors.php",
      "app/Models/User.php",
      "app/Models/UpRole.php",
      "app/Models/Note.php",
      "app/Http/Controllers/Api/AuthController.php",
      "app/Http/Controllers/Api/Generated/NoteApiController.php",
      "app/Http/Serializers/NoteSerializer.php",
      "app/Console/Commands/CamisStrapiSchemaCheck.php",
      "app/Policies/NotePolicy.php",
      "app/Support/Ring1.php",
      "routes/api.php",
      "config/camis.php",
      "DEPLOY.md",
    ]) {
      expect(paths).toContain(p);
    }
    // The protected seams survive: hand-written controller overrides and custom routes.
    expect(
      result.files.find((f) => f.path === "app/Http/Controllers/Api/NoteApiController.php")?.mode,
    ).toBe("seed");
    expect(result.files.find((f) => f.path === "routes/api-custom.php")?.mode).toBe("seed");
  });

  // Two things the cross-backend run proved a deployer has to be told, because getting either
  // wrong produces a silent 404 or a blanket 401 rather than a diagnosable error:
  // firebase/php-jwt refuses an HMAC key shorter than 32 bytes (Strapi accepts any length), and
  // this layout registers routes/api.php without `php artisan install:api` (which would drag in
  // Sanctum).
  it("tells the deployer the shared JWT secret must be at least 32 bytes", () => {
    const deploy = content("DEPLOY.md").replace(/\s+/g, " ");
    expect(deploy).toContain("at least 32 bytes");
    expect(deploy).toContain("firebase/php-jwt");
  });

  it("does not claim the strapi layout runs php artisan install:api", () => {
    const deploy = content("DEPLOY.md");
    expect(deploy).not.toContain("install:api");
    expect(deploy.replace(/\s+/g, " ")).toContain("bootstrap/app.php");
  });

  it("wires the storage-layout variants into routes, config, model and DEPLOY.md", () => {
    expect(content("routes/api.php")).toContain("Route::middleware(StrapiJwtGuard::class)");
    expect(content("config/camis.php")).toContain("'jwt_secret'");
    const note = content("app/Models/Note.php");
    expect(note).toContain("protected $table = 'notes';");
    expect(note).toContain("scopeForUser");
    // The storage model, not the Laravel one: the owner is a link-table row, never a column.
    expect(note).not.toContain("'owner_id'");
    expect(note).toContain("belongsToMany(User::class, 'notes_owner_lnk', 'note_id', 'user_id')");
    expect(content("app/Http/Controllers/Api/Generated/NoteApiController.php")).toContain(
      "notes_owner_lnk",
    );
    // Markdown wraps the paragraph, so compare on the reflowed prose rather than the source line
    // breaks — the sentence is the contract, its column width is not.
    expect(content("DEPLOY.md").replace(/\s+/g, " ")).toContain(
      "Strapi owns the schema: boot Strapi against this database before the first deploy and " +
        "after each schema change; run `php artisan camis:strapi-schema-check`",
    );
  });

  // Task 9's parked concern: the serializer's $wire['columns'] must not name a column the
  // storage model cannot fill. Relations are link-table rows here, so `owner_id` exists nowhere.
  it("keeps the serializer's columns free of link-table foreign keys", () => {
    expect(content("app/Http/Serializers/NoteSerializer.php")).not.toContain("owner_id");
  });

  // The models on this layout leave `date`/`time` uncast (spec 17i), so the serializers the same
  // generate() call emits must read them as the plain strings they are — a `?->toDateString()`
  // here would be a fatal call on a string the first time a Transaction is serialized.
  it("emits serializers that pass an uncast date column straight through", () => {
    const php = content("app/Http/Serializers/TransactionSerializer.php");
    expect(php).toContain("'occurredOn' => $m->occurred_on,");
    expect(php).not.toContain("toDateString");
    expect(content("app/Models/Transaction.php")).not.toContain("'occurred_on' =>");
  });

  it("reports the admin panel and the account routes it leaves to Strapi, and nothing else", () => {
    expect(result.gaps.gaps).toEqual([
      {
        feature: "adminPanelNotEmitted",
        location: {},
        severity: "downgrade",
        message:
          "Filament admin panel resources are not emitted in the strapi storage layout; " +
          "Strapi's own admin panel owns content editing.",
      },
      {
        feature: "usersPermissionsAccounts",
        location: {},
        severity: "downgrade",
        message:
          "the Strapi storage layout serves register, login and /users/me only; password reset " +
          "and change, email confirmation, blocked users, refresh-token sessions, sign-in providers and /users are left to the Strapi instance",
      },
      {
        feature: "apiTokens",
        location: {},
        severity: "downgrade",
        message:
          "the Strapi storage layout does not accept API tokens: the Strapi instance keeps and checks them",
      },
    ]);
  });

  it("is idempotent", () => {
    expect(
      filamentAdapter.generate(storageBundle, {
        projectName: "oyl",
        apiStyle: "strapi",
        storageLayout: "strapi",
      }),
    ).toEqual(result);
  });
});

// The adapter-level guard behind the CLI's own rejection: a strapi storage layout without the
// strapi API style has no serializers or link-table writers, so it falls back rather than
// emitting a half-wired app.
describe("filamentAdapter storageLayout strapi without apiStyle strapi", () => {
  const fallback = filamentAdapter.generate(storageBundle, {
    projectName: "oyl",
    storageLayout: "strapi",
  });

  it("falls back to the laravel layout and reports one error gap", () => {
    expect(
      fallback.gaps.gaps.filter((g) => g.feature === "storageLayoutRequiresStrapiApi"),
    ).toEqual([
      {
        feature: "storageLayoutRequiresStrapiApi",
        location: {},
        severity: "error",
        message:
          'storageLayout "strapi" requires apiStyle "strapi"; the laravel storage layout was ' +
          "generated instead.",
      },
    ]);
    expect(fallback.files.some((f) => f.path.startsWith("database/migrations/"))).toBe(true);
    expect(fallback.files.some((f) => f.path.startsWith("app/Filament/"))).toBe(true);
  });
});

// storageLayout defaults to "laravel": passing it explicitly must not move a single byte.
describe("storageLayout omitted leaves the laravel layout byte-identical", () => {
  it("catalog under the laravel api style", () => {
    expect(filamentAdapter.generate(catalog, { projectName: "blog" })).toEqual(
      filamentAdapter.generate(catalog, { projectName: "blog", storageLayout: "laravel" }),
    );
  });
  it("the strapi api style on the laravel storage layout", () => {
    expect(
      filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi" }),
    ).toEqual(
      filamentAdapter.generate(strapiApiBundle, {
        projectName: "oyl",
        apiStyle: "strapi",
        storageLayout: "laravel",
      }),
    );
  });
});

// A hook (or an AI field) emits app/Observers/<M>Observer.php, but Laravel never calls it unless
// the model declares #[ObservedBy]. On the Laravel layout `emitModel` does that; the storage
// layout emits its own models, so `generate.ts` has to thread the observed set through or every
// Ring 2 hook on this layout is silently dead.
describe("storageLayout strapi with a hook", () => {
  const hooked = filamentAdapter.generate(hooksBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
    storageLayout: "strapi",
  });
  const hookedPaths = hooked.files.map((f) => f.path);

  it("emits the observer file and registers it on the storage model", () => {
    expect(hookedPaths).toContain("app/Observers/ArticleObserver.php");
    const model = hooked.files.find((f) => f.path === "app/Models/Article.php")!.content;
    expect(model).toContain("use App\\Observers\\ArticleObserver;");
    expect(model).toContain(
      "#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy([ArticleObserver::class])]\nclass Article extends Model",
    );
  });

  it("still emits the hook contract and its protected stub", () => {
    expect(hookedPaths).toContain("app/Hooks/Contracts/TransformTitleHook.php");
    expect(hooked.files.find((f) => f.path === "app/Hooks/TransformTitle.php")?.mode).toBe("seed");
  });
});

describe("expectedSchema", () => {
  const doc = normalize(storageBundle.document);
  const schema = expectedSchema(
    doc,
    doc.contentTypes.filter((ct) => ct.builtin === undefined),
  );

  it("lists table keys sorted", () => {
    expect(Object.keys(schema)).toEqual([...Object.keys(schema)].sort());
  });

  it("content tables carry the Strapi-owned columns plus the real scalar columns", () => {
    expect(schema["notes"]).toEqual([
      "id",
      "document_id",
      "created_at",
      "updated_at",
      "published_at",
      "locale",
      "record_id",
      "text",
      "occurred_at",
    ]);
    expect(schema["tasks"]).toEqual([
      "id",
      "document_id",
      "created_at",
      "updated_at",
      "published_at",
      "locale",
      "record_id",
      "title",
    ]);
  });

  it("link tables carry local/foreign, and ord only on an inverse relation", () => {
    expect(schema["notes_owner_lnk"]).toEqual(["note_id", "user_id"]);
    expect(schema["tasks_assignee_lnk"]).toEqual(["task_id", "user_id", "task_ord"]);
    expect(schema["consumables_creator_lnk"]).toEqual(["consumable_id", "user_id"]);
  });

  it("component link tables carry Strapi's generic _cmps columns, nested ones included", () => {
    const cmps = ["id", "entity_id", "cmp_id", "component_type", "field", "order"];
    expect(schema["consumables_cmps"]).toEqual(cmps);
    expect(schema["transactions_cmps"]).toEqual(cmps);
    expect(schema["activity_sessions_cmps"]).toEqual(cmps);
    expect(schema["components_nutrition_nutrition_facts_cmps"]).toEqual(cmps);
    // A content type with no component fields has no _cmps table to check.
    expect(schema["notes_cmps"]).toBeUndefined();
  });

  it("component tables carry id plus their own scalar columns", () => {
    expect(schema["components_finance_money"]).toEqual(["id", "minor", "currency"]);
    expect(schema["components_activity_quantities"]).toEqual(["id", "amount", "unit"]);
    expect(schema["components_nutrition_nutrition_facts"]).toEqual(["id", "calories"]);
    expect(schema["components_shared_serving_sizes"]).toEqual(["id", "amount"]);
    expect(schema["components_nutrition_additional_nutrients"]).toEqual(["id", "slug", "amount"]);
  });

  it("carries the users-permissions tables the auth controller and guard read", () => {
    expect(schema["up_users"]).toEqual([
      "id",
      "document_id",
      "username",
      "email",
      "provider",
      "password",
      "confirmed",
      "blocked",
      "created_at",
      "updated_at",
      "published_at",
      "locale",
    ]);
    expect(schema["up_roles"]).toEqual(["id", "type", "name"]);
    expect(schema["up_users_role_lnk"]).toEqual(["user_id", "role_id", "user_ord"]);
  });
});

describe("CamisStrapiSchemaCheck", () => {
  const php = content("app/Console/Commands/CamisStrapiSchemaCheck.php");

  it("golden", async () => {
    await expect(php).toMatchFileSnapshot("../../__golden__/storage/CamisStrapiSchemaCheck.php");
  });

  it("is an artisan command that fails on any missing table or column", () => {
    expect(php).toContain("namespace App\\Console\\Commands;");
    expect(php).toContain("class CamisStrapiSchemaCheck extends Command");
    expect(php).toContain("protected $signature = 'camis:strapi-schema-check';");
    expect(php).toContain("Schema::hasTable(");
    expect(php).toContain("Schema::hasColumn(");
    expect(php).toContain("$this->error(");
    expect(php).toContain("return self::FAILURE;");
    expect(php).toContain("$this->info('strapi schema ok');");
    expect(php).toContain("return self::SUCCESS;");
  });

  it("carries the expected map as a PHP array literal", () => {
    expect(php).toContain("'notes' => [");
    expect(php).toContain("'tasks_assignee_lnk' => [");
    expect(php).toContain("'up_users_role_lnk' => [");
  });

  describe("php -l", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "storage-schema-check-"));
    });
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it.skipIf(!hasPhp())("lints clean", () => {
      const file = join(dir, "CamisStrapiSchemaCheck.php");
      writeFileSync(file, php);
      const out = execFileSync("php", ["-l", file], { encoding: "utf8" });
      expect(out).toContain("No syntax errors detected");
    });
  });
});
