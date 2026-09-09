import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import type { ContentType } from "@camis/ir-schema";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import {
  emitGeneratedController,
  emitProtectedController,
  type ControllerLink,
} from "./controller";
import { emitApiConfig, emitStrapiRoutes } from "./routes";
import { linkColumns, linkTable, type RelationField } from "./storage/names";
import { storageBundle } from "./storage/__fixtures__/storage";
import { wireShape } from "./wire-shape";

const doc = normalize(strapiApiBundle.document);
const ct = (n: string) => doc.contentTypes.find((c) => c.name === n)!;

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const storageDoc = storageBundle.document;
const storageCt = (n: string): ContentType => {
  const found = storageDoc.contentTypes.find((c) => c.name === n);
  if (!found) throw new Error(`fixture missing content type ${n}`);
  return found;
};

/** One entry per owning relation, in IR order — what Task 11 will hand the emitter. */
const storageLinks = (owner: ContentType): ControllerLink[] =>
  owner.fields
    .filter(
      (f): f is RelationField =>
        f.type === "relation" && (f.relationKind === "manyToOne" || f.relationKind === "oneToOne"),
    )
    .map((f) => ({ relation: f.name, table: linkTable(owner, f.name), ...linkColumns(owner, f) }));

const storageSpec = (name: string, assigns: string[]) => ({
  shape: wireShape(storageDoc, storageCt(name), []),
  ct: storageCt(name),
  assigns,
  secured: true,
  scoped: true,
  layout: "strapi" as const,
  links: storageLinks(storageCt(name)),
});

describe("strapi-api controllers", () => {
  it("Note generated controller golden (upsert by record_id, owner assign)", async () => {
    await expect(
      emitGeneratedController({
        shape: wireShape(doc, ct("Note"), ["owner_id"]),
        ct: ct("Note"),
        assigns: ["owner"],
        secured: true,
        scoped: true,
      }),
    ).toMatchFileSnapshot("./__golden__/strapi-api/Generated.NoteApiController.php");
  });
  it("Activity generated controller golden (creator assign, or-scope)", async () => {
    await expect(
      emitGeneratedController({
        shape: wireShape(doc, ct("Activity"), ["creator_id"]),
        ct: ct("Activity"),
        assigns: ["creator"],
        secured: true,
        scoped: true,
      }),
    ).toMatchFileSnapshot("./__golden__/strapi-api/Generated.ActivityApiController.php");
  });
  it("protected subclass golden", async () => {
    await expect(emitProtectedController("Note")).toMatchFileSnapshot(
      "./__golden__/strapi-api/NoteApiController.php",
    );
  });
  it("routes golden (kebab plural paths, auth + health, sanctum group)", async () => {
    await expect(
      emitStrapiRoutes(
        doc.contentTypes.filter((c) => c.builtin === undefined),
        true,
      ),
    ).toMatchFileSnapshot("./__golden__/strapi-api/routes.api.php");
  });
  // Laravel sorts route middleware by its priority map, which moves Authenticate and
  // ThrottleRequests ahead of any unprioritised middleware — so StrapiErrors applied only to the
  // route group ran LAST, and an unauthenticated request never reached it at all: a 401 returned
  // Laravel's default {"message":"Unauthenticated."} instead of the envelope (proven against a
  // real Laravel 12 app). Prepending it to the `api` group makes it the first pipe for every
  // route in the group; the resolved middleware list is deduplicated, so it still runs once.
  it("prepends StrapiErrors to the api middleware group so it runs before Authenticate", () => {
    const php = emitStrapiRoutes(
      doc.contentTypes.filter((c) => c.builtin === undefined),
      true,
    );
    const lines = php.split("\n");
    const prepend = lines.indexOf("Route::prependMiddlewareToGroup('api', StrapiErrors::class);");
    const group = lines.findIndex((l) => l.startsWith("Route::middleware([StrapiErrors::class])"));
    expect(prepend).toBeGreaterThan(-1);
    expect(prepend).toBeLessThan(group);
  });
  // Unauthenticated credential endpoints are the one place an unbounded request rate is a
  // password-guessing oracle; everything else already sits behind auth:sanctum.
  it("throttles the login and register routes", () => {
    const php = emitStrapiRoutes(
      doc.contentTypes.filter((c) => c.builtin === undefined),
      true,
    );
    expect(php).toContain(
      "Route::post('/auth/local', [AuthController::class, 'login'])->middleware($authThrottle);",
    );
    expect(php).toContain(
      "Route::post('/auth/local/register', [AuthController::class, 'register'])->middleware($authThrottle);",
    );
  });
  // Laravel's unnamed `throttle:N,1` keys on the client IP alone and shares one bucket across
  // both credential routes, so a single hard-coded rate is wrong for every deployment at once:
  // too loose behind a per-user address, and low enough to lock out an office NAT — or an
  // automated acceptance suite that registers an account per test. The rate is an operational
  // knob, so it comes from config (env-overridable, config:cache-safe), not from a literal.
  it("reads the auth throttle rate from config, defaulting to 10 per minute", () => {
    const php = emitStrapiRoutes(
      doc.contentTypes.filter((c) => c.builtin === undefined),
      true,
    );
    expect(php).toContain(
      "$authThrottle = 'throttle:'.(int) config('camis.auth_throttle_per_minute', 10).',1';",
    );
    expect(php).not.toContain("throttle:10,1");
  });
  // `(int) env(...)` casts an unset, empty or non-numeric value to 0, and `throttle:0,1` is not
  // "no limit" — Laravel rejects every request to the credential endpoints with a 429, locking
  // logins out of the deployment. A typo in .env must not be able to do that, so the value is
  // floored at one request per minute.
  it("floors the configured auth throttle at 1 per minute", () => {
    expect(emitApiConfig()).toContain(
      "'auth_throttle_per_minute' => max(1, (int) env('CAMIS_AUTH_THROTTLE_PER_MINUTE', 10)),",
    );
  });
  it("api config golden (auth throttle rate, env-overridable)", async () => {
    await expect(emitApiConfig()).toMatchFileSnapshot("./__golden__/strapi-api/config.camis.php");
  });
  // Outside the group closure the require ran at file scope, so hand-written routes registered
  // with no middleware at all and returned Laravel's default error shape instead of the envelope.
  it("requires api-custom.php inside the StrapiErrors group so custom routes inherit the envelope", () => {
    const php = emitStrapiRoutes(
      doc.contentTypes.filter((c) => c.builtin === undefined),
      true,
    );
    const lines = php.split("\n");
    const requireLine = lines.findIndex((l) => l.includes("require __DIR__"));
    const groupClose = lines.findIndex((l) => l === "});");
    expect(requireLine).toBeGreaterThan(-1);
    expect(requireLine).toBeLessThan(groupClose);
    expect(lines[requireLine]).toBe("    require __DIR__.'/api-custom.php';");
  });
  // A failing child insert after `$m->save()` would otherwise leave the parent row persisted
  // with its children already deleted — the delete-then-reinsert in syncChildren is only safe
  // when both halves share one transaction.
  it("wraps save + syncChildren in a single DB transaction in store and both update branches", () => {
    const php = emitGeneratedController({
      shape: wireShape(doc, ct("Note"), ["owner_id"]),
      ct: ct("Note"),
      assigns: ["owner"],
      secured: true,
      scoped: true,
    });
    expect(php).toContain("use Illuminate\\Support\\Facades\\DB;");
    const store = php.slice(
      php.indexOf("public function store"),
      php.indexOf("public function update"),
    );
    const update = php.slice(
      php.indexOf("public function update"),
      php.indexOf("public function destroy"),
    );
    expect(store).toContain("DB::transaction(");
    // both the update branch and the upsert-create branch
    expect(update.match(/DB::transaction\(/g)).toHaveLength(2);
    // every syncChildren call sits inside a transaction closure, never at bare method-body indent
    const syncLines = php.split("\n").filter((l) => l.includes("NoteSerializer::syncChildren("));
    expect(syncLines).toHaveLength(3);
    for (const line of syncLines) expect(line).toMatch(/^ {12,}NoteSerializer::syncChildren\(/);
  });
  it("without upsertBy the key is id and PUT has no create branch", () => {
    const php = emitGeneratedController({
      shape: wireShape(doc, ct("Tag"), []),
      ct: ct("Tag"),
      assigns: [],
      secured: false,
      scoped: false,
    });
    expect(php).toContain("private const KEY = 'id';");
    expect(php).not.toContain("claimed by another scope");
    expect(php).not.toContain("$m->{self::KEY} = $key");
    expect(php).toContain("        abort(404);\n    }");
    expect(php).not.toContain("->forUser(");
  });
});

describe("strapi storage layout controllers", () => {
  it("Note generated controller golden (upsert by record_id, owner link, components)", async () => {
    await expect(emitGeneratedController(storageSpec("Note", ["owner"]))).toMatchFileSnapshot(
      "../__golden__/storage/Generated.NoteApiController.php",
    );
  });

  it("Task generated controller golden (id key, ordered inverse link)", async () => {
    await expect(emitGeneratedController(storageSpec("Task", ["assignee"]))).toMatchFileSnapshot(
      "../__golden__/storage/Generated.TaskApiController.php",
    );
  });

  // The Laravel layout is the default and must be untouched by this task: the pre-change golden
  // is the contract, compared byte-for-byte rather than re-snapshotted.
  it("omitting layout emits the Laravel-layout controller byte-for-byte", () => {
    const golden = readFileSync(
      fileURLToPath(
        new URL("./__golden__/strapi-api/Generated.NoteApiController.php", import.meta.url),
      ),
      "utf8",
    );
    expect(
      emitGeneratedController({
        shape: wireShape(doc, ct("Note"), ["owner_id"]),
        ct: ct("Note"),
        assigns: ["owner"],
        secured: true,
        scoped: true,
      }),
    ).toBe(golden);
  });

  it("writes rows and link tables through the Strapi runtime, never a FK column", () => {
    const php = emitGeneratedController(storageSpec("Note", ["owner"]));
    expect(php).toContain("use App\\Support\\StrapiComponents;");
    expect(php).toContain("use App\\Support\\StrapiRows;");
    expect(php).toContain("StrapiRows::create($m);");
    expect(php).toContain(
      "StrapiRows::link($m, 'notes_owner_lnk', 'note_id', 'user_id', $request->user()->id, null);",
    );
    expect(php).not.toContain("$m->owner_id = ");
    // The link-table EXISTS subquery belongs to the model's scopeForUser, not the controller.
    expect(php).not.toContain("whereExists");
  });

  it("passes the inverse side's ord column so Strapi's ordered list stays consistent", () => {
    const php = emitGeneratedController(storageSpec("Task", ["assignee"]));
    expect(php).toContain(
      "StrapiRows::link($m, 'tasks_assignee_lnk', 'task_id', 'user_id', $request->user()->id, 'task_ord');",
    );
  });

  it("eager-loads every owning relation in scoped() and batch-loads components in index()", () => {
    const php = emitGeneratedController(storageSpec("Note", ["owner"]));
    expect(php).toContain("return Note::query()->forUser($request->user())->with(['owner']);");
    expect(php).toContain("StrapiComponents::load($rows, Note::COMPONENT_MAP);");
  });

  // Strapi's own validator rejects a duplicate uid with a 400 ValidationError before it ever
  // reaches the database; a bare insert would surface a driver-specific unique-constraint error.
  it("rejects a duplicate upsert key with a ValidationException in store()", () => {
    const php = emitGeneratedController(storageSpec("Note", ["owner"]));
    expect(php).toContain("use Illuminate\\Validation\\ValidationException;");
    const store = php.slice(
      php.indexOf("public function store"),
      php.indexOf("public function update"),
    );
    expect(store).toContain(
      "if (Note::query()->where(self::KEY, $wire['columns'][self::KEY] ?? null)->exists()) {",
    );
    expect(store).toContain(
      "throw ValidationException::withMessages([self::KEY => 'This attribute must be unique']);",
    );
  });

  it("omits the duplicate-key guard (and its import) when the key is id", () => {
    const php = emitGeneratedController(storageSpec("Task", ["assignee"]));
    expect(php).not.toContain("ValidationException");
    expect(php).toContain("private const KEY = 'id';");
  });

  it("deletes components and link rows with the row, inside one transaction", () => {
    const php = emitGeneratedController(storageSpec("Note", ["owner"]));
    const destroy = php.slice(php.indexOf("public function destroy"));
    expect(destroy).toContain("DB::transaction(function () use ($m): void {");
    expect(destroy).toContain("StrapiComponents::deleteAll($m, Note::COMPONENT_MAP);");
    expect(destroy).toContain("StrapiRows::unlinkAll($m, 'notes_owner_lnk', 'note_id');");
  });

  // The storage-layout trait provides no child relation methods, so the Phase 16 child sync has
  // no counterpart here: components are written through StrapiComponents::apply instead.
  it("never calls the serializer's child sync", () => {
    for (const name of ["Note", "Task"]) {
      const php = emitGeneratedController(storageSpec(name, []));
      expect(php).not.toContain("syncChildren");
    }
  });

  it("writes the row and its components in one transaction in store and both update branches", () => {
    const php = emitGeneratedController(storageSpec("Note", ["owner"]));
    const store = php.slice(
      php.indexOf("public function store"),
      php.indexOf("public function update"),
    );
    const update = php.slice(
      php.indexOf("public function update"),
      php.indexOf("public function destroy"),
    );
    expect(store).toContain("$m->fill(StrapiComponents::columnsOf($wire, Note::COMPONENT_MAP));");
    expect(store).toContain("StrapiComponents::apply($m, Note::COMPONENT_MAP, $wire);");
    expect(update.match(/DB::transaction\(/g)).toHaveLength(2);
    expect(update).toContain(
      "$m->fill(StrapiComponents::columnsOf($wire, Note::COMPONENT_MAP))->save();",
    );
    expect(update).toContain("$m->{self::KEY} = $key;");
  });
});

describe("strapi storage layout — assign without a link", () => {
  // An assign whose relation has no link entry would emit a store() that creates the row and
  // never links it: the creator's own scope cannot see it again. That is a generator bug, and
  // a silently orphaned row is the worst possible way to report it.
  it("refuses to emit a controller whose assign has no owning link", () => {
    expect(() => emitGeneratedController({ ...storageSpec("Note", ["owner"]), links: [] })).toThrow(
      'Unknown assign relation "owner" on "Note" (no owning link)',
    );
  });
});

describe("strapi storage layout — no owning relations", () => {
  const tagSpec = {
    shape: wireShape(doc, ct("Tag"), []),
    ct: ct("Tag"),
    assigns: [],
    secured: false,
    scoped: false,
    layout: "strapi" as const,
    links: [],
  };

  it("Tag generated controller golden (no relations, no assigns, unsecured)", async () => {
    await expect(emitGeneratedController(tagSpec)).toMatchFileSnapshot(
      "../__golden__/storage/Generated.TagApiController.php",
    );
  });

  it("omits ->with, the request capture and every unlink", () => {
    const php = emitGeneratedController(tagSpec);
    expect(php).toContain("return Tag::query();");
    expect(php).not.toContain("->with([");
    expect(php).toContain("DB::transaction(function () use ($m, $wire): void {");
    expect(php).not.toContain("StrapiRows::link(");
    expect(php).not.toContain("StrapiRows::unlinkAll(");
    expect(php).toContain("StrapiRows::create($m);");
  });
});

describe("strapi-jwt guarded routes", () => {
  const storageCts = storageDoc.contentTypes.filter((c) => c.builtin === undefined);

  it("routes golden (StrapiJwtGuard group)", async () => {
    await expect(emitStrapiRoutes(storageCts, true, "strapi-jwt")).toMatchFileSnapshot(
      "../__golden__/storage/routes.storage.api.php",
    );
  });

  it("swaps the sanctum group for the Strapi JWT middleware and imports it", () => {
    const php = emitStrapiRoutes(storageCts, true, "strapi-jwt");
    expect(php).toContain("use App\\Http\\Middleware\\StrapiJwtGuard;");
    expect(php).toContain("Route::middleware(StrapiJwtGuard::class)->group(function (): void {");
    expect(php).not.toContain("auth:sanctum");
    expect(php).toContain("Route::get('/users/me', [AuthController::class, 'me']);");
  });

  it("defaults to the sanctum guard and never imports the JWT middleware", () => {
    const php = emitStrapiRoutes(storageCts, true);
    expect(php).toContain("Route::middleware('auth:sanctum')->group(function (): void {");
    expect(php).not.toContain("StrapiJwtGuard");
  });
});

const tagLintSpec = {
  shape: wireShape(doc, ct("Tag"), []),
  ct: ct("Tag"),
  assigns: [],
  secured: false,
  scoped: false,
  layout: "strapi" as const,
  links: [],
};

describe("php -l — strapi storage layout", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "storage-api-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const files: Array<{ name: string; emit: () => string }> = [
    {
      name: "NoteApiController",
      emit: () => emitGeneratedController(storageSpec("Note", ["owner"])),
    },
    {
      name: "TaskApiController",
      emit: () => emitGeneratedController(storageSpec("Task", ["assignee"])),
    },
    { name: "TagApiController", emit: () => emitGeneratedController(tagLintSpec) },
    {
      name: "routes",
      emit: () =>
        emitStrapiRoutes(
          storageDoc.contentTypes.filter((c) => c.builtin === undefined),
          true,
          "strapi-jwt",
        ),
    },
  ];

  it.skipIf(!hasPhp()).each(files)("$name lints clean", ({ name, emit }) => {
    const file = join(dir, `${name}.php`);
    writeFileSync(file, emit());
    const out = execFileSync("php", ["-l", file], { encoding: "utf8" });
    expect(out).toContain("No syntax errors detected");
  });
});
