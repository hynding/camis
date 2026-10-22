import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi 5's OpenAPI 3.1 document (`strapi openapi:generate`), opt-in on the Strapi API style.
// openapi.strapi-php.json is strapi-php's document for the fixture's content types, written by
// `php bin/strapi openapi:generate` with the fixture's types added to its example project. It
// gives every `publishedAt` a default that is the moment it ran; the recording drops those, since
// a generated file carries no timestamps.
const generate = (documentation: boolean) =>
  filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
    documentation,
  });

const DOCUMENT_PATH = "public/documentation/openapi.json";
const PAGE_PATH = "public/documentation/index.html";

interface OpenApiDocument {
  openapi: string;
  info: { title: string; description: string; version: string };
  servers: { url: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
  [key: string]: unknown;
}

const oracle = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/openapi.strapi-php.json"), "utf8"),
) as OpenApiDocument;

// Routes strapi-php documents that camis does not serve: the content-type builder's read API,
// the email plugin's send route, and the media library's admin-style page of files.
const UNSERVED = [
  "/content-type-builder/content-types",
  "/content-type-builder/content-types/{uid}",
  "/content-type-builder/components",
  "/content-type-builder/components/{uid}",
  "/email",
  "/upload/files/page",
];

describe("OpenAPI document", () => {
  it("is generated only when the project asks for it", () => {
    const paths = generate(false).files.map((f) => f.path);
    expect(paths.filter((p) => p.startsWith("public/documentation/"))).toEqual([]);
  });

  it("reports, rather than drops, the document where only the Strapi API style on Laravel storage serves it", () => {
    for (const options of [
      { apiStyle: "laravel" },
      { apiStyle: "strapi", storageLayout: "strapi" },
    ] as const) {
      const other = filamentAdapter.generate(strapiApiBundle, {
        projectName: "oyl",
        documentation: true,
        ...options,
      });
      expect(other.files.map((f) => f.path).filter((p) => p.startsWith("public/"))).toEqual([]);
      expect(other.gaps.gaps.map((g) => g.feature)).toContain("documentation");
    }
  });

  const result = generate(true);
  const content = (p: string) => result.files.find((f) => f.path === p)?.content ?? "";
  const ours = JSON.parse(content(DOCUMENT_PATH) || "{}") as OpenApiDocument;

  it("documents every route camis serves, as Strapi does", () => {
    const served = Object.keys(oracle.paths).filter((p) => !UNSERVED.includes(p));
    expect(Object.keys(ours.paths ?? {}).sort()).toEqual([...served].sort());
    for (const path of served) expect(ours.paths[path], path).toEqual(oracle.paths[path]);
  });

  it("registers the same schemas as Strapi", () => {
    expect(Object.keys(ours.components?.schemas ?? {}).sort()).toEqual(
      Object.keys(oracle.components.schemas).sort(),
    );
    for (const [name, schema] of Object.entries(oracle.components.schemas))
      expect(ours.components.schemas[name], name).toEqual(schema);
  });

  it("carries Strapi's top-level keys, naming the project and serving the API under /api", () => {
    const topLevel = (document: OpenApiDocument) =>
      Object.fromEntries(
        Object.entries(document).filter(
          ([key]) => !["info", "servers", "paths", "components"].includes(key),
        ),
      );
    expect(topLevel(ours)).toEqual(topLevel(oracle));
    const { info, servers } = ours;
    expect(info).toEqual({
      title: "oyl",
      description: "API documentation for oyl v1.0.0",
      version: "1.0.0",
    });
    expect(servers).toEqual([{ url: "/api", description: "Default server" }]);
  });

  it("serves Swagger UI at /documentation, pinned and integrity-checked, without PHP", () => {
    const page = content(PAGE_PATH);
    expect(page).toContain('url: "openapi.json"');
    expect(page).toMatch(
      /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui-bundle\.js" integrity="sha384-[\w+/=]+" crossorigin="anonymous"><\/script>/,
    );
    expect(page).toMatch(
      /<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui\.css" integrity="sha384-[\w+/=]+" crossorigin="anonymous">/,
    );
  });

  it("leaves out the routes of plugins the project does not have", () => {
    const bare = filamentAdapter.generate(
      {
        ...strapiApiBundle,
        document: {
          ...strapiApiBundle.document,
          contentTypes: strapiApiBundle.document.contentTypes.filter(
            (ct) => ct.name === "User" || ct.name === "Tag",
          ),
          components: [],
        },
        roles: strapiApiBundle.roles.map((role) => ({
          ...role,
          grants: role.grants.filter((g) => g.contentType === "User" || g.contentType === "Tag"),
        })),
      },
      { projectName: "oyl", apiStyle: "strapi", documentation: true },
    );
    const document = JSON.parse(
      bare.files.find((f) => f.path === DOCUMENT_PATH)?.content ?? "{}",
    ) as OpenApiDocument;
    const paths = Object.keys(document.paths ?? {});
    expect(paths).toContain("/tags");
    expect(paths).toContain("/auth/local");
    expect(paths.filter((p) => p.startsWith("/upload") || p.startsWith("/i18n"))).toEqual([]);
  });
});
