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
import { forStrapiApiStyle } from "./__fixtures__/strapi-api-style";
import { authorRoleBundle } from "./strapi-api/__fixtures__/author-role";
import { morphRelationsBundle } from "./strapi-api/__fixtures__/morph-relations";
import { strapiApiBundle } from "./strapi-api/__fixtures__/strapi-api";
import { uniqueComponentsBundle } from "./strapi-api/__fixtures__/unique-components";
import { storageBundle } from "./strapi-api/storage/__fixtures__/storage";

type ApiStyle = "laravel" | "strapi";

// The component, when there is one, is Note's repeatable `seo`: its items are rows of their own.
const withFields = (fields: Field[], componentFields: ComponentFieldT[] = []): IrBundle => ({
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Note",
        kind: "collection",
        fields: [
          { type: "string", name: "title" },
          ...fields,
          ...(componentFields.length > 0
            ? [{ type: "component" as const, name: "seo", component: "Seo", repeatable: true }]
            : []),
        ],
      },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
    ],
    components:
      componentFields.length > 0
        ? [{ name: "Seo", fields: [{ type: "string", name: "metaTitle" }, ...componentFields] }]
        : [],
  },
  roles: [],
});

const reserved = (bundle: IrBundle, apiStyle: ApiStyle, storageLayout: ApiStyle = "laravel") =>
  filamentAdapter
    .generate(bundle, { projectName: "notes", apiStyle, storageLayout })
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

    it("reports Strapi's discriminator keys and its strapi prefix, as Strapi does", () => {
      const bundle = withFields([
        { type: "string", name: "kind", names: { api: "__component" } },
        { type: "string", name: "strapiStage" },
      ]);
      expect(reportedFields(bundle, "strapi")).toEqual([
        { contentType: "Note", field: "kind" },
        { contentType: "Note", field: "strapiStage" },
      ]);
      expect(reserved(bundle, "laravel")).toEqual([]);
    });

    // Its key created_by and its key column created_by_id are both Strapi's createdBy: one gap.
    it.each(["createdBy", "updatedBy"])(
      "reports a to-one relation named %s once, for the one key it collides with",
      (name) => {
        const bundle = withFields([
          { type: "relation", name, relationKind: "manyToOne", target: "Tag" },
        ]);
        expect(reserved(bundle, "strapi").map((g) => [g.location, g.message])).toEqual([
          [
            { contentType: "Note", field: name },
            `field "${name}" collides with the Strapi API style's own "${name}"; rename it`,
          ],
        ]);
      },
    );

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

    it("reports a component's field whose column on its items' rows is one", () => {
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

  // On the Laravel storage layout an embedded component's field is a column of the row holding it
  // (the entry's, or an item's, which carries the timestamps too), named by its path snake_cased
  // and joined: `created` holding `at` is created_at. The Strapi storage layout keeps a component
  // in a table of its own, as Strapi does.
  describe("embedded components", () => {
    const stamped = (stamp: ComponentFieldT[], repeatable: boolean): IrBundle => ({
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Note",
            kind: "collection",
            fields: [
              { type: "string", name: "title" },
              { type: "component", name: "created", component: "Stamp", repeatable: false },
              { type: "component", name: "items", component: "Item", repeatable },
            ],
          },
          { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
        ],
        components: [
          { name: "Stamp", fields: stamp },
          {
            name: "Item",
            fields: [{ type: "component", name: "created", component: "Stamp", repeatable: false }],
          },
        ],
      },
      roles: [],
    });
    const at: ComponentFieldT[] = [{ type: "dateTime", name: "at" }];

    it.each(["laravel", "strapi"] as const)(
      "reports a field whose path is created_at, on the entry and on an item, in the %s API style",
      (apiStyle) => {
        const gaps = reserved(stamped(at, true), apiStyle);
        const own = apiStyle === "laravel" ? "created_at" : "createdAt";
        expect(gaps.map((g) => [g.severity, g.location, g.message])).toEqual([
          [
            "error",
            { contentType: "Note", component: "Stamp", field: "at" },
            `field "at" of component "Stamp", embedded in "Note.created" as "created_at", collides with the ${apiStyle === "laravel" ? "Laravel" : "Strapi"} API style's own "${own}"; rename it`,
          ],
          [
            "error",
            { component: "Stamp", field: "at" },
            `field "at" of component "Stamp", embedded in "Item.created" as "created_at", collides with the ${apiStyle === "laravel" ? "Laravel" : "Strapi"} API style's own "${own}"; rename it`,
          ],
        ]);
      },
    );

    // The Strapi API style keeps a to-one relation inside a component, by a key column on the row:
    // the entry's created_by_id is its creator's, while an item's row keeps no creator column.
    it("reports a to-one relation whose key column is created_by_id, on the Strapi API style", () => {
      const by: ComponentFieldT[] = [
        { type: "relation", name: "by", relationKind: "oneToOne", target: "Tag" },
      ];
      expect(reportedFields(stamped(by, true), "strapi")).toEqual([
        { contentType: "Note", component: "Stamp", field: "by" },
      ]);
      // The Laravel API style leaves a relation inside a component out, with a gap of its own.
      expect(reserved(stamped(by, true), "laravel")).toEqual([]);
    });

    // Embedded in Note's `items`, Item's `created.at` is Note's column items_created_at, and
    // `created.by` its items_created_by_id: only the entry's own `created` lands on created_*.
    it.each(["laravel", "strapi"] as const)(
      "checks an embedded component's path from the row holding it only, in the %s API style",
      (apiStyle) => {
        const by: ComponentFieldT[] = [
          { type: "relation", name: "by", relationKind: "oneToOne", target: "Tag" },
        ];
        expect(reportedFields(stamped(at, false), apiStyle)).toEqual([
          { contentType: "Note", component: "Stamp", field: "at" },
        ]);
        expect(reportedFields(stamped(by, false), apiStyle)).toEqual(
          apiStyle === "strapi" ? [{ contentType: "Note", component: "Stamp", field: "by" }] : [],
        );
      },
    );

    // Note.seo embeds Seo, which embeds Stamp as `created`: the column is seo_created_at.
    const nested = (seo: Field): IrBundle => ({
      document: {
        version: 1,
        contentTypes: [
          { name: "Note", kind: "collection", fields: [{ type: "string", name: "title" }, seo] },
        ],
        components: [
          {
            name: "Seo",
            fields: [
              { type: "string", name: "metaTitle" },
              { type: "component", name: "created", component: "Stamp", repeatable: false },
            ],
          },
          { name: "Stamp", fields: at },
        ],
      },
      roles: [],
    });

    it.each(["laravel", "strapi"] as const)(
      "leaves a component embedded in a component that is only embedded, in the %s API style",
      (apiStyle) => {
        const seo: Field = { type: "component", name: "seo", component: "Seo", repeatable: false };
        expect(reserved(nested(seo), apiStyle)).toEqual([]);
      },
    );

    // As a dynamic zone's member, Seo is a table of its own on the Strapi API style, which keeps
    // a zone's members' items as rows; the Laravel API style keeps a zone in one column.
    it("checks a dynamic zone member's paths where its items are rows: the Strapi API style", () => {
      const zone: Field = { type: "dynamicZone", name: "seo", components: ["Seo"] };
      expect(reportedFields(nested(zone), "strapi")).toEqual([{ component: "Stamp", field: "at" }]);
      expect(reserved(nested(zone), "laravel")).toEqual([]);
    });

    // A repeatable inside an item is a table of its own only on the Strapi API style; the Laravel
    // API style leaves it out, with a gap of its own.
    it("checks a repeatable nested in an item where it is a table: the Strapi API style", () => {
      const bundle: IrBundle = {
        document: {
          version: 1,
          contentTypes: [
            {
              name: "Note",
              kind: "collection",
              fields: [{ type: "component", name: "items", component: "Item", repeatable: true }],
            },
          ],
          components: [
            {
              name: "Item",
              fields: [{ type: "component", name: "marks", component: "Mark", repeatable: true }],
            },
            { name: "Mark", fields: [{ type: "dateTime", name: "updatedAt" }] },
          ],
        },
        roles: [],
      };
      expect(reportedFields(bundle, "strapi")).toEqual([{ component: "Mark", field: "updatedAt" }]);
      expect(reserved(bundle, "laravel")).toEqual([]);
    });

    // A repeatable inside an embedded component is a table of the entry's: its items are rows.
    it.each(["laravel", "strapi"] as const)(
      "checks a repeatable inside an embedded component, in the %s API style",
      (apiStyle) => {
        const bundle: IrBundle = {
          document: {
            version: 1,
            contentTypes: [
              {
                name: "Note",
                kind: "collection",
                fields: [{ type: "component", name: "seo", component: "Seo", repeatable: false }],
              },
            ],
            components: [
              {
                name: "Seo",
                fields: [{ type: "component", name: "list", component: "Stamp", repeatable: true }],
              },
              {
                name: "Stamp",
                fields: [
                  { type: "component", name: "created", component: "Mark", repeatable: false },
                ],
              },
              { name: "Mark", fields: at },
            ],
          },
          roles: [],
        };
        expect(reportedFields(bundle, apiStyle)).toEqual([{ component: "Mark", field: "at" }]);
      },
    );

    // The Strapi API style keeps a media library only when a content type has a media field of its
    // own or the document declares a file type (`mediaPlan`); without one a media field inside a
    // component is a path column, as on the Laravel API style, on the entry's row and on an item's.
    it.each(["laravel", "strapi"] as const)(
      "reports a media field, a column without a media library, in the %s API style",
      (apiStyle) => {
        const media: ComponentFieldT[] = [{ type: "media", name: "at" }];
        expect(reportedFields(stamped(media, true), apiStyle)).toEqual([
          { contentType: "Note", component: "Stamp", field: "at" },
          { component: "Stamp", field: "at" },
        ]);
      },
    );

    // With a media library a media field links its files from the row: no column.
    it("leaves a media field that links the media library's files, on the Strapi API style", () => {
      const media: ComponentFieldT[] = [{ type: "media", name: "at" }];
      const bundle = stamped(media, true);
      const withLibrary: IrBundle = {
        ...bundle,
        document: {
          ...bundle.document,
          contentTypes: [
            ...bundle.document.contentTypes,
            { name: "File", kind: "collection", builtin: "file", fields: [] },
          ],
        },
      };
      expect(reserved(withLibrary, "strapi")).toEqual([]);
      expect(reportedFields(withLibrary, "laravel")).toEqual([
        { contentType: "Note", component: "Stamp", field: "at" },
        { component: "Stamp", field: "at" },
      ]);
    });

    it("leaves the Strapi storage layout, where a component is a table of its own", () => {
      expect(reserved(stamped(at, true), "strapi", "strapi")).toEqual([]);
    });
  });

  // The Laravel-style fixtures keep a `publishedAt` field of their own, which only the Strapi API
  // style keeps for itself. They are booted in the Laravel API style only, and a test that runs
  // one in the Strapi API style takes it through `forStrapiApiStyle`, which renames that field. Only
  // draft-publish.test.ts still generates a field named `publishedAt` on the Strapi API style, on
  // purpose: it pins the draft-and-publish plan's own downgrade for such a field, which the adapter
  // reports beside this error for a caller other than the CLI.
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

  it.each([
    ["catalog", catalog],
    ["hooks", hooksBundle],
  ] as [string, IrBundle][])(
    "reports none for the %s fixture taken through forStrapiApiStyle, on either storage layout",
    (_, bundle) => {
      expect(reserved(forStrapiApiStyle(bundle), "strapi")).toEqual([]);
      expect(reserved(forStrapiApiStyle(bundle), "strapi", "strapi")).toEqual([]);
    },
  );
});
