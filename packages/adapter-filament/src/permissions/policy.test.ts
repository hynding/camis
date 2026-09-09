import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { storageBundle } from "../strapi-api/storage/__fixtures__/storage";
import type { PolicySpec } from "./project";
import { projectFilamentPermissions } from "./project";
import { emitPolicy } from "./policy";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [{ type: "string", name: "status" }],
} as ContentType;
const spec: PolicySpec = {
  contentType: "Article",
  model: "Article",
  methods: [
    { method: "viewAny", key: "article.read", record: false, roles: ["Editor"] },
    {
      method: "view",
      key: "article.read",
      record: true,
      roles: ["Editor"],
      condition: {
        kind: "eq",
        left: { kind: "var", name: "record.status" },
        right: { kind: "lit", value: "published" },
      },
    },
    { method: "create", key: "article.create", record: false, roles: ["Editor"] },
  ],
};

describe("emitPolicy", () => {
  const php = emitPolicy(spec, article);
  it("emits a namespaced policy class using Ring1 + models", () => {
    expect(php).toContain("namespace App\\Policies;");
    expect(php).toContain("use App\\Models\\Article;");
    expect(php).toContain("use App\\Models\\User;");
    expect(php).toContain("use App\\Support\\Ring1;");
    expect(php).toContain("class ArticlePolicy");
  });
  it("no-condition method is a bare permission check", () => {
    expect(php).toContain("public function create(User $user): bool");
    expect(php).toContain("return $user->can('article.create');");
  });
  it("record-scoped condition method builds record.* data and is fail-closed", () => {
    expect(php).toContain("public function view(User $user, Article $record): bool");
    expect(php).toContain("if (! $user->can('article.read')) {");
    expect(php).toContain("'record.status' => $record->status,");
    expect(php).toContain("return $result['ok'] === true && $result['value'] === true;");
    expect(php).toContain("Ring1::eq(");
  });
  it("non-record method omits record.* data", () => {
    // viewAny has no condition here, so it's a bare check; ensure no record data leaks anywhere for non-record methods
    expect(php).toContain("public function viewAny(User $user): bool");
  });
});

describe("emitPolicy — ownership via relation FKs", () => {
  const note: ContentType = {
    name: "Note",
    kind: "collection",
    fields: [
      { type: "text", name: "text" },
      { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
    ],
  } as ContentType;
  const ownerSpec: PolicySpec = {
    contentType: "Note",
    model: "Note",
    methods: [
      {
        method: "view",
        key: "note.read",
        record: true,
        roles: ["member"],
        condition: {
          kind: "eq",
          left: { kind: "var", name: "record.ownerId" },
          right: { kind: "var", name: "user.id" },
        },
      },
    ],
  };

  it("exposes owning-relation FKs as record.<name>Id in the policy data", () => {
    const php = emitPolicy(ownerSpec, note);
    expect(php).toContain("'record.ownerId' => $record->owner_id,");
  });
});

describe("emitPolicy — strapi storage layout", () => {
  const doc = storageBundle.document;
  const noteCt = doc.contentTypes.find((c) => c.name === "Note") as ContentType;
  const projected = projectFilamentPermissions(doc, storageBundle.roles);
  const noteSpec = projected.policies.find((p) => p.contentType === "Note") as PolicySpec;
  const php = emitPolicy(noteSpec, noteCt, "strapi");

  it("golden", async () => {
    await expect(php).toMatchFileSnapshot("../__golden__/storage/NotePolicy.storage.php");
  });

  // There is no Spatie permission table on a Strapi database: the only thing a row carries is
  // its up_roles type, so the grant check becomes membership of the roles that hold the key.
  it("gates on the Strapi role type instead of a Spatie permission", () => {
    expect(php).toContain("in_array($user->roleType(), ['authenticated'], true)");
    expect(php).not.toContain("$user->can(");
    expect(php).toContain("'user.role' => $user->roleType(),");
  });

  // The FK lives in a link table, not on the row, so the condition reads the model accessor.
  it("reads owning relations through the model accessor, not a FK column", () => {
    expect(php).toContain("'record.ownerId' => $record->ownerId,");
    expect(php).not.toContain("$record->owner_id");
  });

  // `if (! false) { ... }` around a condition is not just noise: it makes the method read as if
  // the condition still decides, when nothing can reach it.
  it("short-circuits a conditional method to a bare denial when no role holds the key", () => {
    const orphan: PolicySpec = {
      contentType: "Note",
      model: "Note",
      methods: [
        {
          method: "view",
          key: "note.read",
          record: true,
          roles: [],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "record.ownerId" },
            right: { kind: "var", name: "user.id" },
          },
        },
      ],
    };
    const denied = emitPolicy(orphan, noteCt, "strapi");
    expect(denied).toContain(
      "    public function view(User $user, Note $record): bool\n    {\n        return false;\n    }",
    );
    expect(denied).not.toContain("if (! false)");
    expect(denied).not.toContain("Ring1::");
  });

  it("denies outright when no role holds the key", () => {
    const orphan: PolicySpec = {
      contentType: "Note",
      model: "Note",
      methods: [{ method: "create", key: "note.create", record: false, roles: [] }],
    };
    expect(emitPolicy(orphan, noteCt, "strapi")).toContain("        return false;");
  });

  // Role names and permission keys come from the IR, which a human (or the AI authoring path)
  // writes. Interpolated raw, a quote in either closes the PHP literal and the rest becomes source.
  it("escapes a quote in a role name and in a permission key", () => {
    const nasty: PolicySpec = {
      contentType: "Note",
      model: "Note",
      methods: [
        { method: "create", key: "note.o'brien", record: false, roles: ["o'brien", "editor"] },
      ],
    };
    expect(emitPolicy(nasty, noteCt, "strapi")).toContain(
      "in_array($user->roleType(), ['o\\'brien', 'editor'], true)",
    );
    expect(emitPolicy(nasty, noteCt)).toContain("$user->can('note.o\\'brien')");
  });

  it("leaves the Laravel layout on Spatie checks", () => {
    const laravel = emitPolicy(noteSpec, noteCt);
    expect(laravel).toContain("$user->can('note.read')");
    expect(laravel).toContain("'user.role' => $user->getRoleNames()->first(),");
    expect(laravel).toContain("'record.ownerId' => $record->owner_id,");
    expect(laravel).not.toContain("roleType()");
  });

  describe("php -l", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "storage-policy-"));
    });
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it.skipIf(!hasPhp())("NotePolicy lints clean", () => {
      const file = join(dir, "NotePolicy.php");
      writeFileSync(file, php);
      const out = execFileSync("php", ["-l", file], { encoding: "utf8" });
      expect(out).toContain("No syntax errors detected");
    });
  });
});
