import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { PHP_MARKER } from "./hooks/names";
import { runtimePhp } from "./runtime-php";
import { strapiApiBundle } from "./strapi-api/__fixtures__/strapi-api";
import { GRAPHQL_SCHEMA_PATH, emitStrapiGraphql } from "./strapi-api/graphql-runtime";

const sourceFile = (php: string): URL => {
  const path = join(mkdtempSync(join(tmpdir(), "camis-runtime-php-")), "Example.php");
  writeFileSync(path, php);
  return pathToFileURL(path);
};

const phpSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith("__") ? [] : phpSources(path);
    return entry.name.endsWith(".php") ? [path] : [];
  });

describe("runtimePhp", () => {
  it("copies the source with the generated marker under the opening tag", () => {
    const source = sourceFile("<?php\n\ndeclare(strict_types=1);\n\nfinal class Example {}\n");
    expect(runtimePhp(source)).toBe(
      `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nfinal class Example {}\n`,
    );
  });

  it("refuses a source without the opening tag on its own line, naming the file", () => {
    const source = sourceFile("<?php declare(strict_types=1);\n");
    expect(() => runtimePhp(source)).toThrow(/Example\.php must start with "<\?php"/);
  });

  it("keeps the GraphQL schema path the runtime reads in step with the one the generator writes", () => {
    expect(emitStrapiGraphql()).toContain(`private const SCHEMA = '${GRAPHQL_SCHEMA_PATH}';`);
  });

  it("copies every runtime PHP source into a generated project", () => {
    const strapiDir = new URL("./strapi-api/", import.meta.url).pathname;
    const generated = [
      filamentAdapter.generate(strapiApiBundle, {
        projectName: "oyl",
        apiStyle: "strapi",
        graphql: true,
        documentation: true,
      }),
      filamentAdapter.generate(strapiApiBundle, {
        projectName: "oyl",
        apiStyle: "strapi",
        storageLayout: "strapi",
      }),
    ].flatMap((result) => result.files.map((file) => file.content));
    const unused = phpSources(strapiDir).filter(
      (path) => !generated.includes(runtimePhp(pathToFileURL(path))),
    );
    expect(unused.map((path) => relative(strapiDir, path))).toEqual([]);
  });
});
