import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi's data transfer, export side: `php artisan strapi:export` writes the archive
// `strapi export` writes, which Strapi (and strapi-php) import. Their import compares the
// archive's schemas with their own, so the schemas must be Strapi's to the attribute:
// transfer/strapi-php-export.tar.gz holds strapi-php's for the fixture's types. The boot job
// exports what it imported from that archive and compares the two archives' data.
const generate = (options: { apiStyle?: "strapi" | "laravel"; storageLayout?: "strapi" } = {}) =>
  filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi", ...options });

const SCHEMAS_PATH = "resources/strapi/schemas.jsonl";

/** The files of a tar archive, by path. */
const untar = (archive: Buffer): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") break;
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, ""), 8);
    files.set(name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

const jsonl = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const archived = jsonl(
  untar(gunzipSync(readFileSync(join(__dirname, "__fixtures__/transfer/strapi-php-export.tar.gz"))))
    .get("schemas/schemas_00001.jsonl")!
    .toString("utf8"),
);

// strapi-php writes an empty object as `[]`; Strapi (and JSON.parse on either side) as `{}`.
const objects = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.length === 0 ? {} : value.map(objects);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, objects(v)]));
  return value;
};

describe("Strapi data export", () => {
  const result = generate();
  const content = (p: string) => result.files.find((f) => f.path === p)?.content ?? "";

  it("adds `php artisan strapi:export`, with Strapi's export options", () => {
    const command = content("app/Console/Commands/StrapiExport.php");
    expect(command).toContain("protected $signature = 'strapi:export");
    for (const option of [
      "{--f|file=",
      "{--k|key=",
      "{--no-encrypt",
      "{--no-compress",
      "{--only=",
      "{--exclude=",
    ])
      expect(command).toContain(option);
  });

  it("calls only methods the export engine defines", () => {
    // A merge once left the folders' links calling a helper this engine no longer had.
    const engine = content("app/Support/StrapiExport.php");
    const defined = new Set([...engine.matchAll(/function (\w+)\(/g)].map((m) => m[1]));
    for (const [, name] of engine.matchAll(/(?:\$this->|self::)(\w+)\(/g))
      expect(defined, name).toContain(name);
  });

  it("writes Strapi's own schema for every type and component the archive holds", () => {
    const ours = new Map(jsonl(content(SCHEMAS_PATH)).map((s) => [s.uid as string, s]));
    for (const schema of archived)
      expect(objects(ours.get(schema.uid as string)), schema.uid as string).toEqual(
        objects(schema),
      );
  });

  it("writes a timestamp as Strapi stores one, its epoch in milliseconds", () => {
    const engine = content("app/Support/StrapiExport.php");
    expect(engine).toContain("'timestamp' => self::milliseconds($value),");
    expect(engine).toContain("return (string) self::instant($value)->getTimestampMs();");
  });

  it("is generated only on the Strapi API style over Laravel storage", () => {
    for (const options of [{ apiStyle: "laravel" }, { storageLayout: "strapi" }] as const)
      expect(
        generate(options)
          .files.map((f) => f.path)
          .filter((p) => p.includes("StrapiExport") || p === SCHEMAS_PATH),
      ).toEqual([]);
  });

  it("tells the deploy how to move this app's data to Strapi", () => {
    expect(content("DEPLOY.md")).toContain("php artisan strapi:export");
  });
});
