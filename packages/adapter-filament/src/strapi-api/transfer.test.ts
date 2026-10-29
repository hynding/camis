import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi's data transfer, import side: `php artisan strapi:import` reads an archive written by
// `strapi export` (transfer/strapi-php-export.tar.gz, from strapi-php) into the app. What the
// imported app answers is read-vectors.json, recorded from strapi-php after it imported the same
// archive; the boot job replays it. Here: the command exists, and every entity type and link the
// archive holds has somewhere to go.
const IMPORT_ENGINE = "app/Support/StrapiImport.php";

const generate = (options: { apiStyle?: "strapi" | "laravel"; storageLayout?: "strapi" } = {}) =>
  filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi", ...options });

/** The files of a tar archive, by path (ustar: 512-byte headers, data padded to 512). */
const untar = (archive: Buffer): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, ""), 8);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (header[156] === 48 || header[156] === 0)
      files.set(path, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

const archive = untar(
  gunzipSync(readFileSync(join(__dirname, "__fixtures__/transfer/strapi-php-export.tar.gz"))),
);
const lines = (stage: string): Record<string, unknown>[] =>
  [...archive]
    .filter(([path]) => path.startsWith(`${stage}/`) && path.endsWith(".jsonl"))
    .flatMap(([, data]) => data.toString("utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("Strapi data import", () => {
  const result = generate();
  const content = (p: string) => result.files.find((f) => f.path === p)?.content ?? "";

  it("adds `php artisan strapi:import`, with Strapi's export options", () => {
    const command = content("app/Console/Commands/StrapiImport.php");
    expect(command).toContain("protected $signature = 'strapi:import");
    for (const option of ["{--f|file=", "{--k|key=", "{--force", "{--only=", "{--exclude="])
      expect(command).toContain(option);
  });

  it("knows where every entity type of a Strapi archive goes", () => {
    const map = content("app/Support/StrapiTransferMap.php");
    const types = new Set(lines("entities").map((e) => e.type as string));
    for (const type of types) expect(map, type).toContain(`'${type}' => [`);
  });

  it("restores the media library's folders and each file's folder", () => {
    const map = content("app/Support/StrapiTransferMap.php");
    expect(map).toContain(
      "'plugin::upload.folder' => [\n            'plugin' => 'folder',\n            'model' => \\App\\Models\\UploadFolder::class,\n        ],",
    );
    const engine = content(IMPORT_ENGINE);
    expect(engine).toContain("'folder' => $this->folder($type, $entity['id'], $entity['data']),");
    expect(engine).toContain("'plugin_upload_api-folder'");
  });

  it("knows every attribute and link of the archive's content types", () => {
    const map = content("app/Support/StrapiTransferMap.php");
    for (const entity of lines("entities").filter((e) => String(e.type).startsWith("api::")))
      for (const key of Object.keys(entity.data as object))
        expect(map, `${String(entity.type)}.${key}`).toContain(`'${key}' => `);
    for (const link of lines("links").filter((l) => l.kind !== "relation.circular")) {
      const left = link.left as { type: string; field: string };
      if (left.type.startsWith("api::"))
        expect(map, `${left.type}.${left.field}`).toContain(`'${left.field}' => `);
    }
  });

  it("keeps each link's archived position in the list's order column", () => {
    // link-order-export.tar.gz: strapi-php lists these links out of id order.
    const map = content("app/Support/StrapiTransferMap.php");
    expect(map).toMatch(/'order' => 'genre_ord',\s+'inverseOrder' => 'book_ord',/);
    expect(map).toMatch(/'order' => null,\s+'inverseOrder' => 'author_ord',/);
  });

  it("is generated only on the Strapi API style over Laravel storage", () => {
    for (const options of [{ apiStyle: "laravel" }, { storageLayout: "strapi" }] as const)
      expect(
        generate(options)
          .files.map((f) => f.path)
          .filter((p) => p.includes("StrapiImport")),
      ).toEqual([]);
  });

  it("tells the deploy how to move a Strapi project's data in", () => {
    expect(content("DEPLOY.md")).toContain("php artisan strapi:import");
  });

  // Strapi encrypts an export unless told not to; the boot job imports
  // strapi-php-export.tar.gz.enc (the same data, `strapi export -k camis-fixture-key`).
  it("reads an encrypted archive with the key it was exported with", () => {
    expect(content(IMPORT_ENGINE)).not.toContain("not supported");
    expect(content("DEPLOY.md")).toContain("--key");
  });

  // Page.panel is an embedded component holding a repeatable one: its items are child rows.
  it("carries a repeatable component nested in an embedded one, rather than reporting it", () => {
    const map = content("app/Support/StrapiTransferMap.php");
    expect(map).toMatch(/'panel' => \[[\s\S]*?'children' => \[[\s\S]*?'key' => \['items'\]/);
    expect(result.gaps.gaps.filter((g) => g.feature === "dataTransfer")).toEqual([]);
  });

  it("names a role whose permissions differ from the archive's, as the IR's roles are kept", () => {
    expect(content(IMPORT_ENGINE)).toContain("roles are the IR's");
  });

  it("adds `php artisan strapi:import-tokens`, reading Strapi's tokens from its database", () => {
    const command = content("app/Console/Commands/StrapiImportTokens.php");
    expect(command).toContain("protected $signature = 'strapi:import-tokens");
    for (const option of ["{--database=", "{--encryption-key=", "{--force"])
      expect(command).toContain(option);
    expect(content("app/Support/StrapiTokenImport.php")).toContain("final class StrapiTokenImport");
    expect(content("DEPLOY.md")).toContain("php artisan strapi:import-tokens");
  });
});
