import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi 5's GraphQL plugin, opt-in on the Strapi API style. strapi-php's schema for the same
// content types (graphql-schema.strapi-php.graphql, printed from its introspection) is the
// naming oracle, and graphql-vectors.json, recorded from it, is the behaviour.
const generate = (graphql: boolean) =>
  filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi", graphql });

/** A printed schema's definitions by name: `type Book { … }` → Book. */
const blocks = (sdl: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const block of sdl.split(/\n(?=(?:"[^\n]*"\n)?(?:type|input|enum|union|scalar) )/)) {
    const name = /(?:type|input|enum|union|scalar) (\w+)/.exec(block)?.[1];
    if (name !== undefined) out.set(name, block.replace(/^"[^\n]*"\n/, "").trim());
  }
  return out;
};

/** A type's fields, one entry per field with its arguments, as the printer lays them out. */
const fields = (block: string): Map<string, string> => {
  const out = new Map<string, string>();
  const body = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
  for (const field of body.split(/\n(?= {2}\w)/)) {
    const name = /^\s*(\w+)/.exec(field)?.[1];
    if (name !== undefined) out.set(name, field.trim());
  }
  return out;
};

/**
 * A definition with its fields in name order: a type lists its fields in its attributes' order,
 * and the oracle project's Post declares its relations in another order than the fixture's.
 */
const shape = (block: string): string[] => [
  block.slice(0, block.indexOf("{") + 1 || undefined),
  ...[...fields(block).values()].sort(),
];

const oracle = blocks(
  readFileSync(join(__dirname, "__fixtures__/graphql-schema.strapi-php.graphql"), "utf8"),
);

// What strapi-php's schema has that a later part brings: the morph links of a file.
const LATER = /^GenericMorph$/;

describe("GraphQL", () => {
  it("is generated only when the project asks for it", () => {
    const paths = generate(false).files.map((f) => f.path);
    expect(paths.filter((p) => /graphql/i.test(p))).toEqual([]);
  });

  it("reports, rather than drops, GraphQL where only the Strapi API style on Laravel storage serves it", () => {
    for (const options of [
      { apiStyle: "laravel" },
      { apiStyle: "strapi", storageLayout: "strapi" },
    ] as const) {
      const other = filamentAdapter.generate(strapiApiBundle, {
        projectName: "oyl",
        graphql: true,
        ...options,
      });
      expect(other.files.map((f) => f.path).filter((p) => /graphql/i.test(p))).toEqual([]);
      expect(other.gaps.gaps.map((g) => g.feature)).toContain("graphql");
    }
  });

  const result = generate(true);
  const content = (p: string) => result.files.find((f) => f.path === p)?.content ?? "";
  const sdl = content("graphql/schema.graphql");
  const ours = blocks(sdl);

  it("serves the schema, its runtime and its route", () => {
    for (const path of [
      "app/GraphQL/StrapiGraphql.php",
      "app/GraphQL/StrapiGraphqlTypes.php",
      "routes/graphql.php",
    ])
      expect(result.files.map((f) => f.path)).toContain(path);
    expect(content("routes/graphql.php")).toContain("->match(['get', 'post'], '/graphql'");
  });

  // strapi-php answers a token that does not verify on /graphql with the REST error body, a 401.
  it("answers a refused request on /graphql with Strapi's error body", () => {
    expect(content("app/Http/Middleware/StrapiErrors.php")).toContain(
      "if (! $request->is('api/*', 'graphql')) {",
    );
  });

  it("names and shapes every type it shares with Strapi's as Strapi does", () => {
    const shared = [...ours.keys()].filter(
      (name) => oracle.has(name) && !["Query", "Mutation", "UploadFile"].includes(name),
    );
    expect(shared.length).toBeGreaterThan(40);
    for (const name of shared)
      expect(shape(ours.get(name)!), name).toEqual(shape(oracle.get(name)!));
  });

  it("leaves out only the types later phases bring", () => {
    const missing = [...oracle.keys()].filter((name) => !ours.has(name));
    expect(missing.filter((name) => !LATER.test(name))).toEqual([]);
  });

  it("offers each content type's queries and mutations as Strapi does", () => {
    for (const root of ["Query", "Mutation"]) {
      const theirs = fields(oracle.get(root)!);
      const mine = fields(ours.get(root) ?? "");
      for (const [name, field] of theirs) expect(mine.get(name), `${root}.${name}`).toBe(field);
    }
  });

  // graphql-plugin-vectors.json, recorded from strapi-php, is the behaviour.
  it("serves the users-permissions, i18n and upload plugins' own queries and mutations", () => {
    const features = result.gaps.gaps.map((g) => g.feature);
    expect(features).not.toContain("graphqlPluginApis");
    expect(features).not.toContain("graphqlApiTokens");
  });

  it("serves the media library's files without their morph links", () => {
    const theirs = fields(oracle.get("UploadFile")!);
    theirs.delete("related");
    expect(fields(ours.get("UploadFile") ?? "")).toEqual(theirs);
    expect(result.gaps.gaps.map((g) => g.feature)).toContain("graphqlMorphRelations");
  });

  it("tells the deploy how the endpoint is installed and cached", () => {
    const deploy = content("DEPLOY.md");
    expect(deploy).toContain("composer require webonyx/graphql-php");
    expect(deploy).toContain("routes/graphql.php");
    expect(deploy).toContain("bootstrap/cache/camis-graphql.php");
    expect(generate(false).files.find((f) => f.path === "DEPLOY.md")!.content).not.toContain(
      "graphql",
    );
  });

  it("keeps the generated schema stable", async () => {
    await expect(sdl).toMatchFileSnapshot("./__golden__/strapi-api/schema.graphql");
  });
});
