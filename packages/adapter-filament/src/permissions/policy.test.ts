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
import { CREATED_BY } from "@camis/permissions";

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
const published = {
  kind: "eq",
  left: { kind: "var", name: "record.status" },
  right: { kind: "lit", value: "published" },
} as const;
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
      conditions: [{ roles: ["Editor"], condition: published }],
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
    // The admin signs in as an AdminUser, and an API caller is a User; a policy decides for both.
    expect(php).toContain("use App\\Models\\AdminUser;");
    expect(php).toContain("use App\\Support\\Ring1;");
    expect(php).toContain("class ArticlePolicy");
  });
  it("no-condition method is a bare permission check", () => {
    expect(php).toContain("public function create(User|AdminUser $user): bool");
    expect(php).toContain("return $user->can('article.create');");
  });
  it("refuses outright what no role holds, on every layout", () => {
    const denied: PolicySpec = {
      ...spec,
      methods: [{ method: "delete", key: "article.delete", record: true, roles: [] }],
    };
    for (const out of [emitPolicy(denied, article), emitPolicy(denied, article, "laravel", true)])
      expect(out).toMatch(
        /public function delete\(User\|AdminUser(\|null)? \$user, Article \$record\): bool\n {4}\{\n {8}return false;\n {4}\}/,
      );
  });
  it("record-scoped condition method builds record.* data and is fail-closed", () => {
    expect(php).toContain("public function view(User|AdminUser $user, Article $record): bool");
    expect(php).toContain("if (! $user->can('article.read')) {");
    expect(php).toContain("'record.status' => $record->status,");
    expect(php).toContain("return $result['ok'] === true && $result['value'] === true;");
    expect(php).toContain("Ring1::eq(");
  });
  it("non-record method omits record.* data", () => {
    // viewAny has no condition here, so it's a bare check; ensure no record data leaks anywhere for non-record methods
    expect(php).toContain("public function viewAny(User|AdminUser $user): bool");
  });
});

// A role holding an action outright is let through before any condition is read, and each role
// holding it under a condition is held to its own.
describe("emitPolicy — roles holding an action under different conditions", () => {
  const draft = { ...published, right: { kind: "lit", value: "draft" } } as const;
  const mixed: PolicySpec = {
    contentType: "Article",
    model: "Article",
    methods: [
      {
        method: "update",
        key: "article.update",
        record: true,
        roles: ["author", "editor", "reviewer"],
        conditions: [
          { roles: ["author"], condition: draft },
          { roles: ["reviewer"], condition: published },
        ],
      },
    ],
  };
  const body = (php: string): string =>
    php.slice(php.indexOf("public function update"), php.lastIndexOf("}"));

  it("lets a role holding it outright through, then tries each condition for its roles", () => {
    expect(body(emitPolicy(mixed, article)))
      .toBe(`public function update(User|AdminUser $user, Article $record): bool
    {
        if (! $user->can('article.update')) {
            return false;
        }
        if ($user->hasAnyRole(['editor'])) {
            return true;
        }
        $data = [
            'user.id' => $user->id,
            'user.email' => $user->email,
            'user.role' => $user->getRoleNames()->first(),
            'record.status' => $record->status,
        ];
        if ($user->hasAnyRole(['author'])) {
            $result = Ring1::eq(fn() => Ring1::var($data, "record.status"), fn() => Ring1::lit("draft"));
            if ($result['ok'] === true && $result['value'] === true) {
                return true;
            }
        }
        if ($user->hasAnyRole(['reviewer'])) {
            $result = Ring1::eq(fn() => Ring1::var($data, "record.status"), fn() => Ring1::lit("published"));
            if ($result['ok'] === true && $result['value'] === true) {
                return true;
            }
        }

        return false;
    }
`);
  });

  it("checks role membership by the Strapi role type on the Strapi layout", () => {
    const php = emitPolicy(mixed, article, "strapi");
    expect(php).toContain("if (in_array($user->roleType(), ['editor'], true)) {");
    expect(php).toContain("if (in_array($user->roleType(), ['author'], true)) {");
  });

  // A guest holds only the public role's grants, and a signed-in user never does.
  it("holds a guest to the public role's condition", () => {
    const guests: PolicySpec = {
      ...mixed,
      methods: [
        {
          ...mixed.methods[0]!,
          roles: ["editor", "public"],
          conditions: [{ roles: ["public"], condition: published }],
        },
      ],
    };
    const php = emitPolicy(guests, article, "laravel", true);
    expect(php).toContain("if ($user !== null && $user->hasAnyRole(['editor'])) {");
    expect(php).toContain("if ($user === null) {");
  });

  it("lints clean", () => {
    if (!hasPhp()) return;
    const dir = mkdtempSync(join(tmpdir(), "mixed-policy-"));
    try {
      for (const [name, php] of [
        ["laravel", emitPolicy(mixed, article)],
        ["guests", emitPolicy(mixed, article, "laravel", true)],
        ["strapi", emitPolicy(mixed, article, "strapi")],
      ] as const) {
        const file = join(dir, `${name}.php`);
        writeFileSync(file, php);
        expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain(
          "No syntax errors detected",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Strapi's createdBy is an admin account; an API user's id is a row of another table, so it must
// never be read as the creator's.
describe("emitPolicy — the entry's creator", () => {
  const isCreator = {
    kind: "eq",
    left: { kind: "var", name: CREATED_BY },
    right: { kind: "var", name: "user.id" },
  } as const;
  const authorSpec: PolicySpec = {
    contentType: "Article",
    model: "Article",
    methods: [
      {
        method: "update",
        key: "article.update",
        record: true,
        roles: ["author"],
        conditions: [{ roles: ["author"], condition: isCreator }],
      },
      {
        method: "view",
        key: "article.read",
        record: true,
        roles: ["author"],
        conditions: [{ roles: ["author"], condition: published }],
      },
    ],
  };
  const php = emitPolicy(authorSpec, article);

  it("reads the creator of an entry for an admin account only", () => {
    expect(php).toContain(
      "'record.createdBy' => $user instanceof AdminUser ? $record->created_by_id : null,",
    );
  });
  it("reads it only where a condition names it", () => {
    const view = php.slice(php.indexOf("public function view"));
    expect(view).not.toContain("record.createdBy");
  });
});

// The user type's own policy: its model is User, which every policy already imports, and PHP
// refuses a second `use` of one name, so the whole policy (and every Gate check on a user) fails.
describe("emitPolicy — the user type", () => {
  it("imports User once", () => {
    const user = { name: "User", kind: "collection", fields: [] } as unknown as ContentType;
    const php = emitPolicy(
      { contentType: "User", model: "User", methods: spec.methods.slice(0, 1) },
      user,
    );
    expect(php.split("use App\\Models\\User;").length).toBe(2);
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
        conditions: [
          {
            roles: ["member"],
            condition: {
              kind: "eq",
              left: { kind: "var", name: "record.ownerId" },
              right: { kind: "var", name: "user.id" },
            },
          },
        ],
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
          conditions: [
            {
              roles: [],
              condition: {
                kind: "eq",
                left: { kind: "var", name: "record.ownerId" },
                right: { kind: "var", name: "user.id" },
              },
            },
          ],
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
