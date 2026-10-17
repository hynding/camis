import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../hooks/names";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitHasDocumentId, emitStrapiError, emitStrapiQuery } from "./rest-runtime";

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
const content = (p: string): string => {
  const f = result.files.find((x) => x.path === p);
  if (!f) throw new Error(`not generated: ${p}`);
  return f.content;
};

const runtimes = [
  { path: "app/Support/StrapiQuery.php", namespace: "App\\Support", emit: emitStrapiQuery },
  { path: "app/Support/StrapiError.php", namespace: "App\\Support", emit: emitStrapiError },
  {
    path: "app/Models/Concerns/HasDocumentId.php",
    namespace: "App\\Models\\Concerns",
    emit: emitHasDocumentId,
  },
];

describe("Strapi REST runtime files", () => {
  it.each(runtimes)("$path is generated, marked, strict and namespaced", ({ path, namespace }) => {
    const php = content(path);
    expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
    expect(php).toContain(`namespace ${namespace};`);
  });

  it("StrapiQuery golden", async () => {
    await expect(emitStrapiQuery()).toMatchFileSnapshot("./__golden__/strapi-api/StrapiQuery.php");
  });
  it("StrapiError golden", async () => {
    await expect(emitStrapiError()).toMatchFileSnapshot("./__golden__/strapi-api/StrapiError.php");
  });
  it("HasDocumentId golden", async () => {
    await expect(emitHasDocumentId()).toMatchFileSnapshot(
      "./__golden__/strapi-api/HasDocumentId.php",
    );
  });

  describe.skipIf(!hasPhp())("php -l", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "camis-rest-runtime-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it.each(runtimes)("$path parses", ({ emit }) => {
      const file = join(dir, "f.php");
      writeFileSync(file, emit());
      expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain("No syntax errors");
    });
  });
});

describe("documentId on the laravel storage layout", () => {
  it("every content type's migration adds a unique 24-char document_id", () => {
    const migration = result.files.find((f) => f.path.endsWith("_create_tags_table.php"))!.content;
    expect(migration).toContain("$table->string('document_id', 24)->unique();");
  });
  it("every model fills it through HasDocumentId", () => {
    expect(content("app/Models/Tag.php")).toContain("use HasDocumentId;");
  });
  it("is the route key when no upsertBy names another field", () => {
    expect(content("app/Http/Controllers/Api/Generated/TagApiController.php")).toContain(
      "private const KEY = 'document_id';",
    );
    expect(content("app/Http/Controllers/Api/Generated/NoteApiController.php")).toContain(
      "private const KEY = 'record_id';",
    );
  });
  it("is serialized right after id", () => {
    expect(content("app/Http/Serializers/TagSerializer.php")).toMatch(
      /'id' => \$m->id,\n\s+'documentId' => \$m->document_id,/,
    );
  });
});

describe("serializer FIELDS map", () => {
  it("maps top-level, embedded and timestamp wire paths to columns and IR types", () => {
    const php = content("app/Http/Serializers/TransactionSerializer.php");
    expect(php).toContain("public const FIELDS = [");
    expect(php).toContain("'id' => ['column' => 'id', 'type' => 'integer'],");
    expect(php).toContain("'documentId' => ['column' => 'document_id', 'type' => 'string'],");
    expect(php).toContain(
      "'amount.minor' => ['column' => 'amount_minor', 'type' => 'bigInteger'],",
    );
    expect(php).toContain("'createdAt' => ['column' => 'created_at', 'type' => 'dateTime'],");
  });
  it("maps a repeatable component to its child relation and the child's own fields", () => {
    const php = content("app/Http/Serializers/ActivitySessionSerializer.php");
    expect(php).toContain("'quantities' => ['component' => 'quantities', 'fields' => [");
    expect(php).toContain("'unit' => ['column' => 'unit', 'type' => 'string'],");
  });
});

describe("controllers speak Strapi's REST query language", () => {
  const tag = content("app/Http/Controllers/Api/Generated/TagApiController.php");
  it("lists through StrapiQuery and returns meta.pagination", () => {
    expect(tag).toContain(
      "$found = StrapiQuery::find($this->scoped($request), $request->query(), TagSerializer::FIELDS, $request->user());",
    );
    expect(tag).toContain("'meta' => ['pagination' => $found['pagination']]");
  });
  it("renders every response through populate and gives single results an empty meta", () => {
    expect(tag).toContain(
      "StrapiPopulate::one($m, $request->query(), TagSerializer::class, $request->user())",
    );
    expect(tag).toContain("'meta' => new \\stdClass()");
  });
});

describe("Strapi error envelope", () => {
  const middleware = content("app/Http/Middleware/StrapiErrors.php");
  it("renders data: null and details, as Strapi does", () => {
    expect(middleware).toContain(
      "['data' => null, 'error' => ['status' => $status, 'name' => $name, 'message' => $message, 'details' => $details]]",
    );
  });
  it("renders a StrapiError with its own status, name and details", () => {
    expect(middleware).toContain("$e instanceof StrapiError =>");
  });
  it("does not log a StrapiError: it is the client's mistake, and logs fill a shared host's quota", () => {
    expect(middleware).toContain("$this->handler->dontReport(StrapiError::class);");
  });
});

describe("REST config", () => {
  it("mirrors a new Strapi project's api.rest config (defaultLimit 25, maxLimit 100, withCount on)", () => {
    const config = content("config/camis.php");
    expect(config).toContain("'default_limit' => (int) env('CAMIS_REST_DEFAULT_LIMIT', 25),");
    expect(config).toContain("'max_limit' => (int) env('CAMIS_REST_MAX_LIMIT', 100),");
    expect(config).toContain("'with_count' => (bool) env('CAMIS_REST_WITH_COUNT', true),");
  });
});

interface Vector {
  name: string;
  query: string;
  status?: number;
  titles?: string[];
  meta?: unknown;
  error?: { name: string; message: string };
}
const vectorsPath = fileURLToPath(
  new URL("./__fixtures__/rest-query-vectors.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  seed: Record<string, unknown>[];
  vectors: Vector[];
};

describe("REST query conformance vectors", () => {
  it("seed rows only use fields the Book fixture declares", () => {
    const book = strapiApiBundle.document.contentTypes.find((c) => c.name === "Book")!;
    const names = new Set(book.fields.map((f) => f.name));
    for (const row of vectors.seed) for (const k of Object.keys(row)) expect(names).toContain(k);
  });
  it("every vector has a unique name and expects either rows or an error", () => {
    const seen = new Set<string>();
    for (const v of vectors.vectors) {
      expect(seen.has(v.name)).toBe(false);
      seen.add(v.name);
      expect(v.titles !== undefined || v.error !== undefined).toBe(true);
    }
  });
});
