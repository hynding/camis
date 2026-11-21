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
        { contentType: "Note", field: "tags" },
        `inverse "createdBy" of relation "tags" collides with Strapi's own "createdBy"; rename it`,
      ],
    ]);
  });

  it("reports a relation named after one", () => {
    const doc = withFields([
      { type: "relation", name: "updatedBy", relationKind: "manyToOne", target: "Tag" },
    ]);
    expect(reportedFields(doc)).toEqual(["updatedBy"]);
  });

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

  // Strapi's Content-Type Builder also refuses `status`, `meta` and `entry_id`; they are not keys of
  // the entry itself, so an entry with such a field reads and writes as it should.
  it("leaves names that only resemble a reserved one", () => {
    const doc = withFields([
      { type: "dateTime", name: "published" },
      { type: "dateTime", name: "publishedOn" },
      { type: "string", name: "locales" },
      { type: "string", name: "author" },
      { type: "string", name: "status" },
    ]);
    expect(strapiReservedNameGaps(doc)).toEqual([]);
  });
});
