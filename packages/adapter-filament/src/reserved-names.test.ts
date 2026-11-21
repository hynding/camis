import { describe, expect, it } from "vitest";
import type { ComponentFieldT, Field } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";
import { aiFixture } from "./__fixtures__/ai";
import { blog } from "./__fixtures__/blog";
import { bootBundle } from "./__fixtures__/boot";
import { catalog } from "./__fixtures__/catalog";
import { hooksBundle } from "./__fixtures__/hooks";
import { lifecycleHooksBundle } from "./__fixtures__/lifecycle-hooks";
import { permissionsBundle } from "./__fixtures__/permissions";
import { routeHooksBundle } from "./__fixtures__/route-hooks";
import { schedulesBundle } from "./__fixtures__/schedules";
import { authorRoleBundle } from "./strapi-api/__fixtures__/author-role";
import { morphRelationsBundle } from "./strapi-api/__fixtures__/morph-relations";
import { strapiApiBundle } from "./strapi-api/__fixtures__/strapi-api";
import { uniqueComponentsBundle } from "./strapi-api/__fixtures__/unique-components";
import { storageBundle } from "./strapi-api/storage/__fixtures__/storage";

type ApiStyle = "laravel" | "strapi";

const withFields = (fields: Field[], componentFields: ComponentFieldT[] = []): IrBundle => ({
  document: {
    version: 1,
    contentTypes: [
      { name: "Note", kind: "collection", fields: [{ type: "string", name: "title" }, ...fields] },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
    ],
    components:
      componentFields.length > 0
        ? [{ name: "Seo", fields: [{ type: "string", name: "metaTitle" }, ...componentFields] }]
        : [],
  },
  roles: [],
});

const reserved = (bundle: IrBundle, apiStyle: ApiStyle) =>
  filamentAdapter
    .generate(bundle, { projectName: "notes", apiStyle })
    .gaps.gaps.filter((g) => g.feature === "reservedFieldName");

const reportedFields = (bundle: IrBundle, apiStyle: ApiStyle) =>
  reserved(bundle, apiStyle).map((g) => g.location);

describe("Filament target: names its rows and wire shape reserve", () => {
  describe('apiStyle "strapi" answers Strapi\'s REST API', () => {
    it.each([
      "documentId",
      "createdAt",
      "updatedAt",
      "publishedAt",
      "createdBy",
      "updatedBy",
      "locale",
      "localizations",
    ])("reports a field named %s as an error, located", (name) => {
      const gaps = reserved(withFields([{ type: "string", name }]), "strapi");
      expect(gaps.map((g) => [g.severity, g.location])).toEqual([
        ["error", { contentType: "Note", field: name }],
      ]);
    });

    it("names the key it collides with", () => {
      const [gap] = reserved(withFields([{ type: "dateTime", name: "publishedAt" }]), "strapi");
      expect(gap!.message).toBe(
        `field "publishedAt" collides with the Strapi API style's own "publishedAt"; rename it`,
      );
    });

    it("reports a snake_case API key that maps onto one", () => {
      const bundle = withFields([
        { type: "string", name: "stamp", names: { api: "published_at" } },
      ]);
      expect(reportedFields(bundle, "strapi")).toEqual([{ contentType: "Note", field: "stamp" }]);
    });

    // A to-one relation keeps `<name>_id` on the row, beside the row's own document_id.
    it("reports a to-one relation whose key column is one of the row's own", () => {
      const bundle = withFields([
        { type: "relation", name: "document", relationKind: "manyToOne", target: "Tag" },
      ]);
      expect(reserved(bundle, "strapi").map((g) => [g.location, g.message])).toEqual([
        [
          { contentType: "Note", field: "document" },
          `field "document", as "document_id", collides with the Strapi API style's own "documentId"; rename it`,
        ],
      ]);
    });

    it("reports a relation's inverse and a component's field", () => {
      const bundle = withFields(
        [
          {
            type: "relation",
            name: "tags",
            relationKind: "manyToMany",
            target: "Tag",
            inverse: "localizations",
          },
        ],
        [{ type: "string", name: "createdAt" }],
      );
      expect(reportedFields(bundle, "strapi")).toEqual([
        { contentType: "Note", field: "tags" },
        { component: "Seo", field: "createdAt" },
      ]);
    });
  });

  describe('apiStyle "laravel"', () => {
    // Every table, a component's included, carries Laravel's created_at and updated_at.
    it.each(["createdAt", "updatedAt"])("reports a field named %s, whose column is one", (name) => {
      const gaps = reserved(withFields([{ type: "dateTime", name }]), "laravel");
      expect(gaps.map((g) => [g.severity, g.location, g.message])).toEqual([
        [
          "error",
          { contentType: "Note", field: name },
          `field "${name}" collides with the Laravel API style's own "${name.replace("At", "_at").toLowerCase()}"; rename it`,
        ],
      ]);
    });

    it("reports a component's field whose column is one", () => {
      const bundle = withFields([], [{ type: "dateTime", name: "updatedAt" }]);
      expect(reportedFields(bundle, "laravel")).toEqual([{ component: "Seo", field: "updatedAt" }]);
    });

    it("leaves the names only Strapi's API keeps", () => {
      const bundle = withFields([
        { type: "string", name: "documentId" },
        { type: "dateTime", name: "publishedAt" },
        { type: "string", name: "locale" },
        { type: "relation", name: "createdBy", relationKind: "manyToOne", target: "Tag" },
      ]);
      expect(reserved(bundle, "laravel")).toEqual([]);
    });
  });

  // A built-in type maps onto the host app's own model and table (users, or Strapi's up_users):
  // nothing is generated from its fields, so they are not checked.
  it.each(["laravel", "strapi"] as const)(
    "leaves a built-in type's fields in the %s API style",
    (apiStyle) => {
      const bundle: IrBundle = {
        document: {
          version: 1,
          contentTypes: [
            {
              name: "User",
              kind: "collection",
              builtin: "user",
              fields: [{ type: "dateTime", name: "updatedAt" }],
            },
          ],
          components: [],
        },
        roles: [],
      };
      expect(reserved(bundle, apiStyle)).toEqual([]);
    },
  );

  // The Laravel-style fixtures keep a `publishedAt` field of their own, which only the Strapi API
  // style keeps for itself; they are generated, and booted, in the Laravel API style only.
  it.each([
    ["ai", aiFixture],
    ["blog", blog],
    ["boot", bootBundle],
    ["catalog", catalog],
    ["hooks", hooksBundle],
    ["lifecycle hooks", lifecycleHooksBundle],
    ["permissions", permissionsBundle],
    ["route hooks", routeHooksBundle],
    ["schedules", schedulesBundle],
  ] as [string, IrBundle][])(
    "reports none for the %s fixture in the Laravel API style",
    (_, bundle) => {
      expect(reserved(bundle, "laravel")).toEqual([]);
    },
  );

  it.each([
    ["author role", authorRoleBundle],
    ["morph relations", morphRelationsBundle],
    ["strapi api", strapiApiBundle],
    ["unique components", uniqueComponentsBundle],
    ["storage", storageBundle],
  ] as [string, IrBundle][])(
    "reports none for the %s fixture, in either API style",
    (_, bundle) => {
      expect(reserved(bundle, "laravel")).toEqual([]);
      expect(reserved(bundle, "strapi")).toEqual([]);
    },
  );
});
