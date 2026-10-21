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

const oracle = blocks(
  readFileSync(join(__dirname, "__fixtures__/graphql-schema.strapi-php.graphql"), "utf8"),
);

// What strapi-php's schema has that this phase leaves to later ones: its users-permissions and
// i18n plugins' own types, the media library's own queries and mutations, and its morph links.
const LATER =
  /^(UsersPermissions|I18NLocale(?!Code)|GenericMorph$|UploadFileEntityResponseCollection$|FileInfoInput$)/;

describe("GraphQL", () => {
  it("is generated only when the project asks for it", () => {
    const paths = generate(false).files.map((f) => f.path);
    expect(paths.filter((p) => /graphql/i.test(p))).toEqual([]);
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
    expect(content("routes/graphql.php")).toContain("Route::match(['get', 'post'], '/graphql'");
  });

  it("names and shapes every type it shares with Strapi's as Strapi does", () => {
    const shared = [...ours.keys()].filter(
      (name) => oracle.has(name) && !["Query", "Mutation", "UploadFile"].includes(name),
    );
    expect(shared.length).toBeGreaterThan(40);
    for (const name of shared) expect(ours.get(name), name).toBe(oracle.get(name));
  });

  it("leaves out only the types later phases bring", () => {
    const missing = [...oracle.keys()].filter((name) => !ours.has(name));
    expect(missing.filter((name) => !LATER.test(name))).toEqual([]);
  });

  it("offers each content type's queries and mutations as Strapi does", () => {
    for (const root of ["Query", "Mutation"]) {
      const theirs = fields(oracle.get(root)!);
      const mine = fields(ours.get(root) ?? "");
      for (const [name, field] of theirs)
        if (
          !/^(usersPermissions|i18NLocale|uploadFile|updateUploadFile|deleteUploadFile|register|login|forgotPassword|resetPassword|changePassword|emailConfirmation|me|createUsersPermissions|updateUsersPermissions|deleteUsersPermissions)/.test(
            name,
          )
        )
          expect(mine.get(name), `${root}.${name}`).toBe(field);
    }
  });

  it("serves the media library's files without their morph links", () => {
    const theirs = fields(oracle.get("UploadFile")!);
    theirs.delete("related");
    expect(fields(ours.get("UploadFile") ?? "")).toEqual(theirs);
    expect(result.gaps.gaps.map((g) => g.feature)).toContain("graphqlMorphRelations");
  });

  it("keeps the generated schema stable", async () => {
    await expect(sdl).toMatchFileSnapshot("./__golden__/strapi-api/schema.graphql");
  });
});
