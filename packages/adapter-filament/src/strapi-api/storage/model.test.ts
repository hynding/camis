import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { PHP_MARKER } from "../../hooks/names";
import { emitScopeMethod } from "../scope";
import { componentMap } from "./component-map";
import { storageBundle } from "./__fixtures__/storage";
import { emitStorageModel, emitStorageUpRoleModel, emitStorageUserModel } from "./model";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const doc = storageBundle.document;
const ct = (name: string): ContentType => {
  const found = doc.contentTypes.find((c) => c.name === name);
  if (!found) throw new Error(`fixture missing content type ${name}`);
  return found;
};
const grant = (contentType: string) => {
  const found = storageBundle.roles[0]?.grants.find((g) => g.contentType === contentType);
  if (!found) throw new Error(`fixture missing grant for ${contentType}`);
  return found;
};
const emit = (name: string, scopeMethod: string | undefined = undefined): string =>
  emitStorageModel(ct(name), doc, componentMap(doc, ct(name)), scopeMethod);

describe("emitStorageModel — file shape", () => {
  it.each(["Note", "Transaction", "ActivitySession", "Consumable", "Task"])(
    "%s opens with the marker, strict types and the App\\Models namespace",
    (name) => {
      const php = emit(name);
      expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
      expect(php).toContain("namespace App\\Models;");
      expect(php.endsWith("\n")).toBe(true);
    },
  );

  it.each(["Note", "Transaction", "ActivitySession", "Consumable", "Task"])(
    "%s is idempotent",
    (name) => {
      expect(emit(name)).toBe(emit(name));
    },
  );
});

describe("Note model", () => {
  it("golden", async () => {
    await expect(emit("Note")).toMatchFileSnapshot("../../__golden__/storage/Note.model.php");
  });

  it("has an owning BelongsToMany through the link table, an ?int accessor, and the trait", () => {
    const php = emit("Note");
    expect(php).toContain("use App\\Support\\StrapiComponentAttributes;");
    expect(php).toContain("use StrapiComponentAttributes;");
    expect(php).toContain(
      "return $this->belongsToMany(User::class, 'notes_owner_lnk', 'note_id', 'user_id');",
    );
    expect(php).toContain("public function getOwnerIdAttribute(): ?int");
    expect(php).toContain("return $this->owner->first()?->id;");
  });

  it("casts the Strapi-owned datetimes and every IR dateTime field with StrapiDateTime", () => {
    const php = emit("Note");
    expect(php).toContain("use App\\Casts\\StrapiDateTime;");
    expect(php).toContain("'created_at' => StrapiDateTime::class,");
    expect(php).toContain("'updated_at' => StrapiDateTime::class,");
    expect(php).toContain("'published_at' => StrapiDateTime::class,");
    expect(php).toContain("'occurred_at' => StrapiDateTime::class,");
  });

  it("declares all three component constants, empty since Note has no components", () => {
    const php = emit("Note");
    expect(php).toContain("public const COMPONENT_ATTRIBUTES = [];");
    expect(php).toContain("public const COMPONENT_RELATIONS = [];");
    expect(php).toContain("public const COMPONENT_MAP = [];");
  });

  it("$fillable is real scalar columns plus the Strapi-owned columns, no FK column", () => {
    const php = emit("Note");
    expect(php).toContain("'record_id',");
    expect(php).toContain("'text',");
    expect(php).toContain("'occurred_at',");
    expect(php).toContain("'document_id',");
    expect(php).toContain("'published_at',");
    expect(php).toContain("'locale',");
    expect(php).not.toContain("'owner_id',");
  });

  it("splices a given scopeMethod verbatim, importing Builder", () => {
    const scope = emitScopeMethod(ct("Note"), grant("Note").condition).php;
    const php = emit("Note", scope);
    expect(php).toContain("scopeForUser");
    expect(php).toContain("use Illuminate\\Database\\Eloquent\\Builder;");
    expect(php).toContain(scope);
  });

  it("omits the scope method and its Builder import when none is given", () => {
    const php = emit("Note");
    expect(php).not.toContain("scopeForUser");
    expect(php).not.toContain("use Illuminate\\Database\\Eloquent\\Builder;");
  });
});

describe("Consumable model", () => {
  it("golden", async () => {
    await expect(emit("Consumable")).toMatchFileSnapshot(
      "../../__golden__/storage/Consumable.model.php",
    );
  });

  it("renders the nested component map literal with the runtime's keys only", () => {
    const php = emit("Consumable");
    expect(php).toContain("'components_nutrition_nutrition_facts_cmps'");
    expect(php).toContain("'relationName' => 'factsAdditional'");
    expect(php).not.toContain("wireKey");
    expect(php).not.toContain("flatPrefix");
  });

  it("puts every non-repeatable scalar's flatAttribute in COMPONENT_ATTRIBUTES", () => {
    const php = emit("Consumable");
    expect(php).toContain("'facts_calories'");
    expect(php).toContain("'facts_serving_size_amount'");
  });

  it("puts every repeatable's relationName in COMPONENT_RELATIONS, keeping its scalars out of COMPONENT_ATTRIBUTES", () => {
    const php = emit("Consumable");
    expect(php).toContain(
      "public const COMPONENT_RELATIONS = [\n        'factsAdditional',\n    ];",
    );
    const attributesBlock = php.slice(
      php.indexOf("COMPONENT_ATTRIBUTES"),
      php.indexOf("COMPONENT_RELATIONS"),
    );
    expect(attributesBlock).not.toContain("'slug'");
    // The repeatable's own scalars still live in COMPONENT_MAP — the runtime loader needs them
    // to hydrate each child row — just not flattened onto the owner as attributes.
    expect(php).toContain("'slug'");
  });

  it("has the owning creator relation, not a creator_id fillable column", () => {
    const php = emit("Consumable");
    expect(php).toContain(
      "return $this->belongsToMany(User::class, 'consumables_creator_lnk', 'consumable_id', 'user_id');",
    );
    expect(php).not.toContain("'creator_id',");
  });
});

describe("Task model", () => {
  it("golden", async () => {
    await expect(emit("Task")).toMatchFileSnapshot("../../__golden__/storage/Task.model.php");
  });

  it("never mentions task_ord — ord is a write-time concern, not a model concern", () => {
    const php = emit("Task");
    expect(php).not.toContain("task_ord");
  });

  it("still links the owning assignee relation through its link table", () => {
    const php = emit("Task");
    expect(php).toContain(
      "return $this->belongsToMany(User::class, 'tasks_assignee_lnk', 'task_id', 'user_id');",
    );
  });
});

// A hook or an AI field emits an observer class, but Laravel only calls it when the model says
// so: on the Laravel layout `emitModel` writes the #[ObservedBy] attribute, and the storage model
// has to do the same or the observer file is dead code.
describe("observed models", () => {
  const observed = (name: string): string =>
    emitStorageModel(ct(name), doc, componentMap(doc, ct(name)), undefined, true);

  it("declares the observer attribute and imports the observer class", () => {
    const php = observed("Note");
    expect(php).toContain("use App\\Observers\\NoteObserver;");
    expect(php).toContain(
      "#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy([NoteObserver::class])]\nclass Note extends Model",
    );
  });

  it("keeps the observer import in the sorted import block", () => {
    const php = observed("Note");
    const uses = php.split("\n").filter((l) => l.startsWith("use "));
    expect(uses).toEqual([...uses].sort());
    expect(uses).toContain("use App\\Observers\\NoteObserver;");
  });

  it("emits neither by default", () => {
    const php = emit("Note");
    expect(php).not.toContain("ObservedBy");
    expect(php).not.toContain("NoteObserver");
  });

  it("is idempotent", () => {
    expect(observed("Note")).toBe(observed("Note"));
  });
});

describe("emitStorageUserModel", () => {
  it("golden", async () => {
    await expect(emitStorageUserModel()).toMatchFileSnapshot(
      "../../__golden__/storage/User.model.php",
    );
  });

  it("is App\\Models\\User extends Authenticatable on up_users", () => {
    const php = emitStorageUserModel();
    expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
    expect(php).toContain("namespace App\\Models;");
    expect(php).toContain("use Illuminate\\Foundation\\Auth\\User as Authenticatable;");
    expect(php).toContain("class User extends Authenticatable");
    expect(php).toContain("'up_users'");
  });

  it("hides password, casts confirmed/blocked as boolean and datetimes with StrapiDateTime", () => {
    const php = emitStorageUserModel();
    expect(php).toContain("protected $hidden = [\n        'password',\n    ];");
    expect(php).toContain("'confirmed' => 'boolean',");
    expect(php).toContain("'blocked' => 'boolean',");
    expect(php).toContain("'created_at' => StrapiDateTime::class,");
  });

  it("relates to roles through up_users_role_lnk and exposes roleType()", () => {
    const php = emitStorageUserModel();
    expect(php).toContain(
      "return $this->belongsToMany(UpRole::class, 'up_users_role_lnk', 'user_id', 'role_id');",
    );
    expect(php).toContain("public function roleType(): ?string");
    expect(php).toContain("return $this->roles->first()?->type;");
  });

  it("is idempotent", () => {
    expect(emitStorageUserModel()).toBe(emitStorageUserModel());
  });
});

describe("emitStorageUpRoleModel", () => {
  it("golden", async () => {
    await expect(emitStorageUpRoleModel()).toMatchFileSnapshot(
      "../../__golden__/storage/UpRole.model.php",
    );
  });

  it("is App\\Models\\UpRole on up_roles", () => {
    const php = emitStorageUpRoleModel();
    expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
    expect(php).toContain("class UpRole extends Model");
    expect(php).toContain("'up_roles'");
    expect(php).toContain("'name',");
    expect(php).toContain("'type',");
    expect(php).toContain("'description',");
  });

  it("is idempotent", () => {
    expect(emitStorageUpRoleModel()).toBe(emitStorageUpRoleModel());
  });
});

describe("php -l", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "storage-model-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const files: Array<{ name: string; emit: () => string }> = [
    { name: "Note", emit: () => emit("Note") },
    { name: "Transaction", emit: () => emit("Transaction") },
    { name: "ActivitySession", emit: () => emit("ActivitySession") },
    { name: "Consumable", emit: () => emit("Consumable") },
    { name: "Task", emit: () => emit("Task") },
    // The observer attribute sits between the imports and `class`, where a stray newline would
    // be a parse error rather than a diff.
    {
      name: "NoteObserved",
      emit: () => emitStorageModel(ct("Note"), doc, componentMap(doc, ct("Note")), undefined, true),
    },
    { name: "User", emit: emitStorageUserModel },
    { name: "UpRole", emit: emitStorageUpRoleModel },
  ];

  it.skipIf(!hasPhp()).each(files)("$name lints clean", ({ name, emit: e }) => {
    const file = join(dir, `${name}.php`);
    writeFileSync(file, e());
    const out = execFileSync("php", ["-l", file], { encoding: "utf8" });
    expect(out).toContain("No syntax errors detected");
  });
});
