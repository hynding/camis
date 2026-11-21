import { describe, expect, it } from "vitest";
import type { Field, IrDocument } from "@camis/ir-schema";
import { strapiReservedNameGaps } from "./reserved-names";

const withFields = (fields: Field[]): IrDocument => ({
  version: 1,
  contentTypes: [
    { name: "Note", kind: "collection", fields: [{ type: "string", name: "title" }, ...fields] },
    { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
  ],
  components: [],
});

const reportedFields = (doc: IrDocument): (string | undefined)[] =>
  strapiReservedNameGaps(doc).map((g) => g.location.field);

describe("strapiReservedNameGaps", () => {
  it.each([
    "documentId",
    "createdAt",
    "updatedAt",
    "publishedAt",
    "createdBy",
    "updatedBy",
    "locale",
    "localizations",
    "createdById",
    "updatedById",
  ])("reports a field named %s as an error, naming the content type and field", (name) => {
    const gaps = strapiReservedNameGaps(withFields([{ type: "string", name }]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      feature: "reservedFieldName",
      severity: "error",
      location: { contentType: "Note", field: name },
    });
  });

  it("names the Strapi key it collides with", () => {
    const [gap] = strapiReservedNameGaps(withFields([{ type: "dateTime", name: "publishedAt" }]));
    expect(gap!.message).toBe(
      `field "publishedAt" collides with Strapi's own "publishedAt"; rename it`,
    );
  });

  // Strapi snake_cases an attribute key for its column, as its Content-Type Builder compares them.
  it.each(["published_at", "PublishedAt", "ID", "document_id"])(
    "reports an API key %s that snake_cases onto a reserved name",
    (api) => {
      const gaps = strapiReservedNameGaps(
        withFields([{ type: "string", name: "stamp", names: { api } }]),
      );
      expect(gaps.map((g) => g.location)).toEqual([{ contentType: "Note", field: "stamp" }]);
      expect(gaps[0]!.message).toContain(`field "stamp", as "${api}", collides`);
    },
  );

  it("reports a relation's inverse, which Strapi adds to the related type", () => {
    const doc = withFields([
      {
        type: "relation",
        name: "tags",
        relationKind: "manyToMany",
        target: "Tag",
        inverse: "createdBy",
      },
    ]);
    const gaps = strapiReservedNameGaps(doc);
    expect(gaps.map((g) => [g.location, g.message])).toEqual([
      [
        { contentType: "Tag", field: "createdBy" },
        `inverse "createdBy" of relation "Note.tags" collides with Strapi's own "createdBy"; rename it`,
      ],
    ]);
  });

  // Renaming the relation alone would leave its inverse's collision on Tag.
  it.each([
    ["updatedBy", "updatedBy"],
    ["strapiOwner", "strapiNotes"],
  ])("reports a relation %s and its inverse %s, each where it lands", (name, inverse) => {
    const doc = withFields([
      { type: "relation", name, relationKind: "manyToOne", target: "Tag", inverse },
    ]);
    expect(strapiReservedNameGaps(doc).map((g) => g.location)).toEqual([
      { contentType: "Note", field: name },
      { contentType: "Tag", field: inverse },
    ]);
  });

  it("reports a relation named after one", () => {
    const doc = withFields([
      { type: "relation", name: "updatedBy", relationKind: "manyToOne", target: "Tag" },
    ]);
    expect(reportedFields(doc)).toEqual(["updatedBy"]);
  });

  // A built-in type is a plugin's own content type: no schema.json of ours carries its fields.
  it("leaves a built-in type's fields", () => {
    const doc: IrDocument = {
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
    };
    expect(strapiReservedNameGaps(doc)).toEqual([]);
  });

  // Its relation's inverse is an attribute of the related type's schema.json, which camis writes.
  it.each(["createdBy", "publishedAt"])(
    "reports a built-in type's relation whose inverse %s lands on a type of ours",
    (inverse) => {
      const doc: IrDocument = {
        version: 1,
        contentTypes: [
          {
            name: "User",
            kind: "collection",
            builtin: "user",
            fields: [
              {
                type: "relation",
                name: "notes",
                relationKind: "oneToMany",
                target: "Note",
                inverse,
              },
            ],
          },
          { name: "Note", kind: "collection", fields: [{ type: "string", name: "title" }] },
        ],
        components: [],
      };
      expect(strapiReservedNameGaps(doc).map((g) => [g.location, g.message])).toEqual([
        [
          { contentType: "Note", field: inverse },
          `inverse "${inverse}" of relation "User.notes" collides with Strapi's own "${inverse}"; rename it`,
        ],
      ]);
    },
  );

  // Strapi's Content-Type Builder refuses the same keys in a component.
  it("reports a component's field", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [],
      components: [{ name: "Seo", fields: [{ type: "string", name: "locale" }] }],
    };
    expect(strapiReservedNameGaps(doc).map((g) => g.location)).toEqual([
      { component: "Seo", field: "locale" },
    ]);
  });

  // `__component` names a dynamic zone item's component on Strapi's wire, beside the item's own
  // keys, and `__contentType` is Strapi's other discriminator key; only an API key can spell them.
  it.each([
    ["__component", "__component"],
    ["__contentType", "__contentType"],
  ])("reports an API key %s, one of Strapi's discriminator keys", (api, own) => {
    const gaps = strapiReservedNameGaps(
      withFields([{ type: "string", name: "kind", names: { api } }]),
    );
    expect(gaps.map((g) => [g.location, g.message])).toEqual([
      [
        { contentType: "Note", field: "kind" },
        `field "kind", as "${api}", collides with Strapi's own "${own}"; rename it`,
      ],
    ]);
  });

  it("reports a dynamic zone member's field keyed __component, which its items would repeat", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Page",
          kind: "collection",
          fields: [{ type: "dynamicZone", name: "blocks", components: ["Hero"] }],
        },
      ],
      components: [
        {
          name: "Hero",
          fields: [{ type: "string", name: "variant", names: { api: "__component" } }],
        },
      ],
    };
    expect(strapiReservedNameGaps(doc).map((g) => [g.severity, g.location])).toEqual([
      ["error", { component: "Hero", field: "variant" }],
    ]);
  });

  // Strapi keeps the strapi prefix for its own columns and attributes (review workflows'
  // strapi_stage and strapi_assignee among them), with one or two leading underscores too.
  it.each([
    ["strapiStage", undefined],
    ["strapiness", undefined],
    ["stage", "strapi_stage"],
    ["stage", "_strapi_stage"],
    ["stage", "__strapiStage"],
    ["stage", "StrapiStage"],
  ])("reports a field %s (API key %s) named with Strapi's own prefix", (name, api) => {
    const field: Field =
      api === undefined ? { type: "string", name } : { type: "string", name, names: { api } };
    const gaps = strapiReservedNameGaps(withFields([field]));
    expect(gaps.map((g) => [g.severity, g.location])).toEqual([
      ["error", { contentType: "Note", field: name }],
    ]);
    expect(gaps[0]!.message).toContain(`collides with Strapi's own "strapi*"; rename it`);
  });

  // Strapi's Content-Type Builder also refuses `status` (since 5.48), `meta` and `entry_id`, which
  // camis leaves: none is a key of the entry itself, so an entry with such a field reads and writes
  // as it should (`meta` sits beside `data` in a response, not in an entry), and Strapi only warns of
  // `status` when it boots. The blog fixtures keep a `status` and the catalogs a `meta`.
  it("leaves names that only resemble a reserved one, and those camis lets through", () => {
    const doc = withFields([
      { type: "dateTime", name: "published" },
      { type: "dateTime", name: "publishedOn" },
      { type: "string", name: "locales" },
      { type: "string", name: "author" },
      { type: "string", name: "status" },
      { type: "json", name: "meta" },
      { type: "integer", name: "entryId" },
      { type: "string", name: "entry", names: { api: "entry_id" } },
      { type: "string", name: "myStrapi" },
      { type: "string", name: "strap" },
      { type: "string", name: "component", names: { api: "_component" } },
    ]);
    expect(strapiReservedNameGaps(doc)).toEqual([]);
  });
});
