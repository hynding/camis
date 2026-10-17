import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentType } from "@camis/ir-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../hooks/names";
import { emitHookObserver } from "../hooks/observer";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitHasDraftAndPublish, emitStrapiDocuments } from "./draft-publish-runtime";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const result = filamentAdapter.generate(strapiApiBundle, {
  projectName: "oyl",
  apiStyle: "strapi",
});
const content = (p: string, r = result): string => {
  const f = r.files.find((x) => x.path === p || x.path.endsWith(p));
  if (!f) throw new Error(`not generated: ${p}`);
  return f.content;
};

const runtimes = [
  { path: "app/Support/StrapiDocuments.php", namespace: "App\\Support", emit: emitStrapiDocuments },
  {
    path: "app/Models/Concerns/HasDraftAndPublish.php",
    namespace: "App\\Models\\Concerns",
    emit: emitHasDraftAndPublish,
  },
];

describe("draft and publish runtime files", () => {
  it.each(runtimes)("$path is generated, marked, strict and namespaced", ({ path, namespace }) => {
    const php = content(path);
    expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
    expect(php).toContain(`namespace ${namespace};`);
  });
  it("StrapiDocuments golden", async () => {
    await expect(emitStrapiDocuments()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiDocuments.php",
    );
  });
  it("HasDraftAndPublish golden", async () => {
    await expect(emitHasDraftAndPublish()).toMatchFileSnapshot(
      "./__golden__/strapi-api/HasDraftAndPublish.php",
    );
  });
  describe.skipIf(!hasPhp())("php -l", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "camis-draft-publish-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it.each(runtimes)("$path parses", ({ emit }) => {
      const file = join(dir, "f.php");
      writeFileSync(file, emit());
      expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain("No syntax errors");
    });
  });
});

describe("two rows per document", () => {
  it("lets a draft and its published version share a documentId", () => {
    const posts = content("_create_posts_table.php");
    expect(posts).toContain("$table->string('document_id', 24)->index();");
    expect(posts).toContain("$table->timestamp('published_at')->nullable();");
    expect(content("_create_books_table.php")).toContain(
      "$table->string('document_id', 24)->unique();",
    );
  });
  it("gives the model the versioning trait", () => {
    expect(content("app/Models/Post.php")).toContain("use HasDraftAndPublish;");
    expect(content("app/Models/Book.php")).not.toContain("HasDraftAndPublish");
  });
  it("unlinks, rather than blocks, when a linked published version goes away", () => {
    expect(content("_create_books_table.php")).toContain(
      "$table->foreignId('topic_id')->nullable()->constrained('topics')->nullOnDelete();",
    );
  });
});

describe("serializers of draft-and-publish types", () => {
  const post = content("app/Http/Serializers/PostSerializer.php");
  it("send publishedAt, null on a draft, as Strapi does", () => {
    expect(post).toContain(
      "'publishedAt' => $m->published_at?->toIso8601ZuluString('millisecond'),",
    );
    expect(post).toContain("'publishedAt' => ['column' => 'published_at', 'type' => 'dateTime'],");
  });
  it("say whether the type keeps two versions", () => {
    expect(post).toContain("public const DRAFT_PUBLISH = true;");
    expect(content("app/Http/Serializers/BookSerializer.php")).toContain(
      "public const DRAFT_PUBLISH = false;",
    );
  });
  it("say which side holds each relation's link and whether its target keeps versions", () => {
    expect(post).toContain("'topics' => ['relation' => 'topics', 'kind' => 'belongsToMany',");
    expect(post).toMatch(/'topics' => \[[^\n]*'holder' => 'self', 'draftPublish' => true\],/);
    expect(content("app/Http/Serializers/AuthorSerializer.php")).toMatch(
      /'books' => \[[^\n]*'holder' => 'target', 'draftPublish' => false\],/,
    );
  });
});

describe("controllers of draft-and-publish types", () => {
  const post = content("app/Http/Controllers/Api/Generated/PostApiController.php");
  it("read the version the status parameter names, published by default", () => {
    expect(post).toContain(
      "return StrapiDocuments::version(Post::query()->forUser($request->user()), $request->query());",
    );
  });
  it("write the draft, then publish it unless status=draft, behind the publish grant", () => {
    expect(post).toContain("if (! StrapiDocuments::draftOnly($request->query())) {");
    expect(post).toContain("$this->authorize('publish', $m);");
    expect(post).toContain("$m = StrapiDocuments::publish($m, PostSerializer::class);");
  });
  it("edit through the draft row", () => {
    expect(post).toContain("$m = StrapiDocuments::draft($this->scoped($request), $key);");
  });
  it("delete every version of the document", () => {
    expect(post).toContain("StrapiDocuments::destroy($m);");
  });
  it("leave types without draft and publish as they are", () => {
    expect(content("app/Http/Controllers/Api/Generated/BookApiController.php")).not.toContain(
      "StrapiDocuments",
    );
  });
});

describe("the Filament admin edits drafts", () => {
  const resource = content("app/Filament/Resources/Posts/PostResource.php");
  it("lists one row per document, its draft", () => {
    expect(resource).toContain(
      "return parent::getEloquentQuery()->whereNull('published_at')->with('publishedVersion');",
    );
  });
  it("shows each document's status", () => {
    expect(content("app/Filament/Resources/Posts/Schemas/PostTable.php")).toContain(
      "TextColumn::make('status')->state(fn ($record) => StrapiDocuments::status($record))->badge()",
    );
  });
  it("publishes, unpublishes and discards from the edit page, behind the grants", () => {
    const edit = content("app/Filament/Resources/Posts/Pages/EditPost.php");
    expect(edit).toContain("Action::make('publish')");
    expect(edit).toContain("->authorize('publish')");
    expect(edit).toContain("StrapiDocuments::publish($this->record, PostSerializer::class)");
    expect(edit).toContain("Action::make('unpublish')");
    expect(edit).toContain("StrapiDocuments::unpublish($this->record)");
    expect(edit).toContain("Action::make('discard')");
    expect(edit).toContain("StrapiDocuments::discard($this->record, PostSerializer::class)");
  });
  it("offers only drafts when linking a draft-and-publish type", () => {
    expect(content("app/Filament/Resources/Posts/Schemas/PostForm.php")).toContain(
      "Select::make('topics')->multiple()->relationship(name: 'topics', titleAttribute: 'id', modifyQueryUsing: fn ($query) => $query->whereNull('published_at'))",
    );
  });
});

describe("draft and publish capability gaps", () => {
  const gapsFor = (ct: ContentType, apiStyle: "strapi" | "laravel" = "strapi") =>
    filamentAdapter
      .generate(
        { roles: [], document: { version: 1, contentTypes: [ct], components: [] } },
        { projectName: "x", apiStyle },
      )
      .gaps.gaps.filter((g) => g.feature === "draftPublish");
  const base: ContentType = {
    name: "Page",
    kind: "collection",
    options: { draftPublish: true },
    fields: [{ type: "string", name: "slug" }],
  };
  it("reports that the Laravel API style keeps one version", () => {
    expect(gapsFor(base, "laravel")).toHaveLength(1);
    expect(gapsFor(base)).toHaveLength(0);
  });
  it("drops draft and publish where upsertBy makes the key unique per row", () => {
    const upsert = { ...base, options: { draftPublish: true, upsertBy: "slug" } };
    expect(gapsFor(upsert)[0]?.message).toContain("upsertBy");
  });
  it("drops draft and publish where a field already claims publishedAt", () => {
    const clash: ContentType = {
      ...base,
      fields: [{ type: "dateTime", name: "publishedAt" }],
    };
    expect(gapsFor(clash)[0]?.message).toContain("publishedAt");
  });
  it("reports that a unique field is not enforced across a document's versions", () => {
    const unique: ContentType = {
      ...base,
      fields: [{ type: "string", name: "slug", unique: true }],
    };
    expect(gapsFor(unique)[0]?.location).toEqual({ contentType: "Page", field: "slug" });
  });
});

describe("onPublish hooks on a draft-and-publish type", () => {
  it("also run when a document's published version is first created", () => {
    const ct: ContentType = {
      name: "Page",
      kind: "collection",
      options: { draftPublish: true },
      fields: [{ type: "string", name: "title" }],
    };
    const hook = {
      name: "TransformTitle",
      contentType: "Page",
      trigger: "onPublish" as const,
      input: [{ type: "string" as const, name: "title" }],
      output: [{ type: "string" as const, name: "title" }],
    };
    expect(emitHookObserver(hook, ct)).toContain("public function created(Page $record): void");
  });
});

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");

describe("draft and publish conformance vectors", () => {
  it("every step has a unique name and a recorded strapi-php outcome", () => {
    const vectors = JSON.parse(fixture("draft-publish-vectors.json")) as {
      writes: { name: string }[];
    };
    const expected = JSON.parse(fixture("draft-publish-vectors.expected.json")) as object;
    const names = vectors.writes.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(expected).sort()).toEqual([...names].sort());
  });
});
