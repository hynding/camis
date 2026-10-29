import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";

// A blocks field (Strapi's rich text) is stored as Strapi stores it, a JSON list of blocks, and
// edited in Filament's rich editor through StrapiBlocks, which converts between the blocks and
// the editor's document. blocks-editor-vectors.json is the conversion's contract.
const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const BIO = { name: "Bio", fields: [{ type: "blocks" as const, name: "text" }] };

const bundle = (
  fields: IrBundle["document"]["contentTypes"][number]["fields"],
  components: IrBundle["document"]["components"] = [BIO],
): IrBundle => ({
  document: {
    version: 1,
    contentTypes: [
      { name: "File", kind: "collection", builtin: "file", fields: [] },
      { name: "Article", kind: "collection", fields },
    ],
    components,
  },
  roles: [],
});

const RUNTIME = [
  "app/Support/StrapiBlocks.php",
  "app/Filament/Forms/BlocksEditor.php",
  "app/Filament/Forms/BlocksStateCast.php",
];

describe("blocks fields on the Filament target", () => {
  const withBlocks = filamentAdapter.generate(bundle([{ type: "blocks", name: "body" }]), {
    projectName: "blog",
    apiStyle: "strapi",
  });
  const content = (p: string) => withBlocks.files.find((f) => f.path === p)?.content ?? "";

  it("generates with no gap, and the editor's runtime", () => {
    expect(withBlocks.gaps.gaps.filter((g) => g.feature === "blocks")).toEqual([]);
    const paths = withBlocks.files.map((f) => f.path);
    for (const path of RUNTIME) expect(paths).toContain(path);
  });

  it("generates the runtime for a blocks field inside a component", () => {
    const inComponent = filamentAdapter.generate(
      bundle([{ type: "component", name: "bio", component: "Bio", repeatable: false }]),
      { projectName: "blog" },
    );
    const paths = inComponent.files.map((f) => f.path);
    for (const path of RUNTIME) expect(paths).toContain(path);
  });

  it("generates no runtime without a blocks field", () => {
    const plain = filamentAdapter.generate(bundle([{ type: "string", name: "title" }], []), {
      projectName: "blog",
    });
    const paths = plain.files.map((f) => f.path);
    for (const path of RUNTIME) expect(paths).not.toContain(path);
  });

  it("edits blocks as the rich editor's JSON document, offering only what blocks hold", () => {
    const editor = content("app/Filament/Forms/BlocksEditor.php");
    expect(editor).toContain("class BlocksEditor extends RichEditor");
    expect(editor).toContain("$this->json();");
    expect(editor).not.toContain("attachFiles");
    expect(editor).toContain("new BlocksStateCast($cast)");
  });

  it("finds an image block's file in the media library by its URL", () => {
    const cast = content("app/Filament/Forms/BlocksStateCast.php");
    expect(cast).toContain("File::query()->where('url', $url)->first()");
    expect(cast).toContain("FileSerializer::toWire($file)");
    const laravel = filamentAdapter.generate(bundle([{ type: "blocks", name: "body" }]), {
      projectName: "blog",
    });
    const plainCast =
      laravel.files.find((f) => f.path === "app/Filament/Forms/BlocksStateCast.php")?.content ?? "";
    expect(plainCast).not.toContain("File::query()");
  });

  it("serves blocks on the API as Strapi does: a JSON value in GraphQL, a list in OpenAPI", () => {
    const documented = filamentAdapter.generate(bundle([{ type: "blocks", name: "body" }]), {
      projectName: "blog",
      apiStyle: "strapi",
      graphql: true,
      documentation: true,
    });
    const file = (p: string) => documented.files.find((f) => f.path === p)?.content ?? "";
    expect(file("graphql/schema.graphql")).toMatch(/type Article \{[^}]*\n {2}body: JSON\n/);
    type Body = { properties: { data: { properties: Record<string, unknown> } } };
    const openapi = JSON.parse(file("public/documentation/openapi.json")) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const schemaOf = (body: unknown): Body =>
      (body as { content: { "application/json": { schema: Body } } }).content["application/json"]
        .schema;
    const read = schemaOf(
      (openapi.paths["/articles/{id}"]!.get!.responses as Record<string, unknown>)["200"],
    );
    const written = schemaOf(openapi.paths["/articles"]!.post!.requestBody);
    // strapi-php's blocksToSchema and blocksToInputSchema: z.array(z.any()).describe(...)
    const listed = { description: "A blocks field", type: "array", items: {} };
    expect(read.properties.data.properties.body).toEqual(listed);
    expect(written.properties.data.properties.body).toEqual(listed);
  });

  it("moves blocks through Strapi's data transfer as JSON", () => {
    expect(content("app/Support/StrapiImport.php")).toContain("'json', 'blocks' => json_encode(");
    expect(content("app/Support/StrapiExport.php")).toContain("'json', 'blocks' => self::json(");
  });

  describe.skipIf(!hasPhp())("StrapiBlocks, run by PHP", () => {
    interface Vector {
      name: string;
      blocks: unknown;
      editor: unknown;
      files?: Record<string, unknown>;
    }
    const vectors = JSON.parse(
      readFileSync(join(__dirname, "__fixtures__/blocks-editor-vectors.json"), "utf8"),
    ) as { roundTrip: Vector[]; fromEditor: Vector[] };

    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "camis-blocks-"));
      writeFileSync(join(dir, "StrapiBlocks.php"), content("app/Support/StrapiBlocks.php"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    /** Every vector through PHP: toEditor of its blocks, fromEditor of its editor document. */
    const run = (list: Vector[]): { toEditor: unknown; fromEditor: unknown }[] => {
      const input = join(dir, "vectors.json");
      writeFileSync(input, JSON.stringify(list));
      const script = `require '${dir}/StrapiBlocks.php';
        $out = [];
        foreach (json_decode(file_get_contents('${input}'), true) as $v) {
          $files = $v['files'] ?? [];
          $out[] = [
            'toEditor' => App\\Support\\StrapiBlocks::toEditor($v['blocks']),
            'fromEditor' => App\\Support\\StrapiBlocks::fromEditor($v['editor'], fn (string $url): ?array => $files[$url] ?? null),
          ];
        }
        echo json_encode($out, JSON_PRESERVE_ZERO_FRACTION);`;
      return JSON.parse(execFileSync("php", ["-r", script], { encoding: "utf8" })) as {
        toEditor: unknown;
        fromEditor: unknown;
      }[];
    };

    it("converts each way without loss", () => {
      const results = run(vectors.roundTrip);
      vectors.roundTrip.forEach((v, i) => {
        expect(results[i]!.toEditor, `${v.name}: toEditor`).toEqual(v.editor);
        expect(results[i]!.fromEditor, `${v.name}: fromEditor`).toEqual(v.blocks);
      });
    });

    it("reads what the editor writes as Strapi's editor would have written it", () => {
      const results = run(vectors.fromEditor);
      vectors.fromEditor.forEach((v, i) =>
        expect(results[i]!.fromEditor, v.name).toEqual(v.blocks),
      );
    });

    it("lists a document's text for the admin's table", () => {
      const script = `require '${dir}/StrapiBlocks.php';
        echo App\\Support\\StrapiBlocks::plainText(json_decode('${JSON.stringify(vectors.roundTrip[0]!.blocks)}', true)), '|', App\\Support\\StrapiBlocks::plainText(null);`;
      expect(execFileSync("php", ["-r", script], { encoding: "utf8" })).toBe(
        "Plain, bold and a link|",
      );
    });
  });
});
