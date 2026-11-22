import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";
import { strapiAdapter } from "./generate";
import { importDocument } from "./import/import-document";
import { blog } from "./__fixtures__/blog";
import { permissionsBundle } from "./__fixtures__/permissions";
import { roundTrip } from "./__fixtures__/round-trip";
import { publicReadBundle } from "./__fixtures__/note-grants";

const reservedGaps = (bundle: IrBundle) =>
  strapiAdapter
    .generate(bundle, { projectName: "notes" })
    .gaps.gaps.filter((g) => g.feature === "reservedFieldName");

// The issue's report: Strapi overwrites publishedAt and refuses a write naming updatedAt.
const note: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Note",
      kind: "collection",
      fields: [
        { type: "string", name: "title" },
        { type: "dateTime", name: "publishedAt" },
        { type: "dateTime", name: "updatedAt" },
      ],
    },
  ],
  components: [],
};

describe("Strapi target: names Strapi reserves", () => {
  it("reports each as an error gap before anything is written, naming the type and field", () => {
    expect(reservedGaps({ document: note, roles: [] })).toEqual([
      {
        feature: "reservedFieldName",
        location: { contentType: "Note", field: "publishedAt" },
        severity: "error",
        message: `field "publishedAt" collides with Strapi's own "publishedAt"; rename it`,
      },
      {
        feature: "reservedFieldName",
        location: { contentType: "Note", field: "updatedAt" },
        severity: "error",
        message: `field "updatedAt" collides with Strapi's own "updatedAt"; rename it`,
      },
    ]);
  });

  it.each([
    ["blog", { document: blog, roles: [] }],
    ["permissions", permissionsBundle],
    ["round-trip", { document: roundTrip, roles: [] }],
    ["note grants", publicReadBundle],
  ] as [string, IrBundle][])("reports none for the %s fixture", (_, bundle) => {
    expect(reservedGaps(bundle)).toEqual([]);
  });
});

const schemaFile = (attributes: Record<string, unknown>) => ({
  path: "src/api/page/content-types/page/schema.json",
  content: JSON.stringify({
    kind: "collectionType",
    collectionName: "pages",
    info: { singularName: "page", pluralName: "pages", displayName: "Page" },
    options: { draftAndPublish: true },
    pluginOptions: { i18n: { localized: true } },
    attributes,
  }),
});

describe("importing a Strapi project", () => {
  // Strapi keeps its own keys out of schema.json and its builder refuses them as attributes.
  it("a project's schema.json imports and generates with no reserved name", () => {
    const { document } = importDocument([
      schemaFile({
        hero_title: { type: "string", pluginOptions: { i18n: { localized: true } } },
        published_on: { type: "date" },
        slug: { type: "uid", targetField: "hero_title" },
      }),
    ]);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(reservedGaps({ document: document.value, roles: [] })).toEqual([]);
  });

  it("a schema.json edited by hand to carry one imports as it is, and generation reports it", () => {
    const { document } = importDocument([schemaFile({ published_at: { type: "datetime" } })]);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(reservedGaps({ document: document.value, roles: [] })).toEqual([
      {
        feature: "reservedFieldName",
        location: { contentType: "Page", field: "publishedAt" },
        severity: "error",
        message: `field "publishedAt", as "published_at", collides with Strapi's own "publishedAt"; rename it`,
      },
    ]);
  });
});
