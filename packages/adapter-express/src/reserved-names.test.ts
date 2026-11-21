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

  // An embedded component's field is a column of the entry's table named by its path, snake_cased
  // and joined: `created` holding `at` is created_at, beside the timestamps.
  const embedding = (repeatable: boolean): IrBundle => ({
    document: {
      version: 1,
      contentTypes: [
        {
          name: "Note",
          kind: "collection",
          fields: [
            { type: "string", name: "title" },
            { type: "component", name: "created", component: "Stamp", repeatable },
            { type: "component", name: "updated", component: "Change", repeatable },
          ],
        },
      ],
      components: [
        { name: "Stamp", fields: [{ type: "dateTime", name: "at" }] },
        {
          name: "Change",
          fields: [{ type: "component", name: "edit", component: "Stamp", repeatable: false }],
        },
      ],
    },
    roles: [],
  });

  it("reports an embedded component's field whose column is a timestamp, located", () => {
    expect(reserved(embedding(false))).toEqual([
      {
        feature: "reservedFieldName",
        location: { contentType: "Note", component: "Stamp", field: "at" },
        severity: "error",
        message: `field "at" of component "Stamp", embedded in "Note.created" as "created_at", collides with the Express target's own "created_at"; rename it`,
      },
    ]);
  });

  it("leaves a repeatable component's fields, rows of a table without timestamps", () => {
    expect(reserved(embedding(true))).toEqual([]);
  });

  // An item table's rows keep a key to their entry, `<type>_id`, beside the item's columns.
  it("reports an item's field whose column is the key to its entry, located", () => {
    const bundle: IrBundle = {
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Note",
            kind: "collection",
            fields: [{ type: "component", name: "items", component: "Item", repeatable: true }],
          },
          {
            name: "Post",
            kind: "collection",
            fields: [{ type: "component", name: "items", component: "Item", repeatable: true }],
          },
        ],
        components: [
          {
            name: "Item",
            fields: [
              { type: "integer", name: "noteId" },
              { type: "integer", name: "position" },
              { type: "component", name: "post", component: "Ref", repeatable: false },
            ],
          },
          { name: "Ref", fields: [{ type: "integer", name: "id" }] },
        ],
      },
      roles: [],
    };
    expect(reserved(bundle)).toEqual([
      {
        feature: "reservedFieldName",
        location: { component: "Item", field: "noteId" },
        severity: "error",
        message: `field "noteId" of component "Item", in "Note.items" as "note_id", collides with the Express target's own "note_id"; rename it`,
      },
      {
        feature: "reservedFieldName",
        location: { component: "Ref", field: "id" },
        severity: "error",
        message: `field "id" of component "Ref", embedded in "Item.post" as "post_id", collides with the Express target's own "post_id"; rename it`,
      },
    ]);
  });

  // A built-in type is a plain table with the same timestamps, its fields columns like any other's.
  it.each([
    ["user", "updatedAt"],
    ["file", "createdAt"],
  ] as const)("reports a %s built-in type's field named %s", (builtin, name) => {
    const bundle: IrBundle = {
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Account",
            kind: "collection",
            builtin,
            fields: [
              { type: "string", name: "username" },
              { type: "dateTime", name },
            ],
          },
        ],
        components: [],
      },
      roles: [],
    };
    expect(reserved(bundle).map((g) => [g.severity, g.location])).toEqual([
      ["error", { contentType: "Account", field: name }],
    ]);
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
