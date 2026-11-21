import { describe, expect, it } from "vitest";
import type { ComponentFieldT, Field } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";
import { expressAdapter } from "./generate";
import { aiFixture } from "./__fixtures__/ai";
import { blog } from "./__fixtures__/blog";
import { catalog } from "./__fixtures__/catalog";
import { morphs } from "./__fixtures__/morphs";
import { secured } from "./__fixtures__/secured";

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
            ? [{ type: "component" as const, name: "seo", component: "Seo", repeatable: false }]
            : []),
        ],
      },
    ],
    components: componentFields.length > 0 ? [{ name: "Seo", fields: componentFields }] : [],
  },
  roles: [],
});

const reserved = (bundle: IrBundle) =>
  expressAdapter
    .generate(bundle, { projectName: "notes" })
    .gaps.gaps.filter((g) => g.feature === "reservedFieldName");

describe("Express target: names its tables reserve", () => {
  // Every table carries createdAt and updatedAt, as the columns created_at and updated_at, and a
  // field's column is its name in snake_case.
  it.each([
    ["createdAt", "created_at"],
    ["updatedAt", "updated_at"],
  ])("reports a field named %s as an error, located", (name, column) => {
    expect(reserved(withFields([{ type: "dateTime", name }]))).toEqual([
      {
        feature: "reservedFieldName",
        location: { contentType: "Note", field: name },
        severity: "error",
        message: `field "${name}" collides with the Express target's own "${column}"; rename it`,
      },
    ]);
  });

  // A component's fields are columns prefixed with the field that holds it, or rows of a table of
  // their own without timestamps.
  it("leaves a component's fields and the names only Strapi keeps", () => {
    const bundle = withFields(
      [
        { type: "dateTime", name: "publishedAt" },
        { type: "string", name: "documentId" },
        { type: "string", name: "locale" },
      ],
      [{ type: "dateTime", name: "createdAt" }],
    );
    expect(reserved(bundle)).toEqual([]);
  });

  it.each([
    ["ai", aiFixture],
    ["blog", blog],
    ["catalog", catalog],
    ["morphs", morphs],
    ["secured", secured],
  ] as [string, IrBundle][])("reports none for the %s fixture", (_, bundle) => {
    expect(reserved(bundle)).toEqual([]);
  });
});
