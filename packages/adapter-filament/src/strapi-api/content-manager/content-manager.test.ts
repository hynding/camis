import { describe, expect, it } from "vitest";
import type { Component, Field, IrDocument } from "@camis/ir-schema";
import { contentManagerAttributes, viewAttributeRow } from "./content-manager";
import { emitStrapiComponentViews } from "./component-views";

const rating: Field = {
  type: "integer",
  name: "rating",
  editor: { name: "plugin::stars.rating", options: { max: 5 } },
};

describe("a custom field in Strapi's Content Manager view", () => {
  // Strapi sizes a custom field by the inputSize its registration gives, which only the running
  // app knows: the view names the custom field so StrapiContentManager can ask CustomFields.
  it("names the custom field a type's attribute is edited with", () => {
    const attributes = contentManagerAttributes(
      [{ field: rating, components: ["TextInput::make('rating')"], column: "rating" }],
      [],
      [],
      [],
    );
    const row = attributes.find((a) => a.name === "rating");
    expect(row?.customField).toBe("plugin::stars.rating");
    expect(
      viewAttributeRow({
        name: "rating",
        type: "integer",
        list: true,
        sort: true,
        edit: true,
        customField: "plugin::stars.rating",
      }),
    ).toBe(
      "'rating' => ['type' => 'integer', 'list' => true, 'sort' => true, 'edit' => true, 'size' => 4, 'resizable' => true, 'customField' => 'plugin::stars.rating'],",
    );
  });

  it("names it in a component's view too", () => {
    const component: Component = { name: "review", fields: [rating] } as Component;
    const doc = { contentTypes: [], components: [component] } as unknown as IrDocument;
    expect(emitStrapiComponentViews(doc, true)).toContain(
      "'rating' => ['type' => 'integer', 'list' => true, 'sort' => true, 'edit' => true, 'size' => 4, 'resizable' => true, 'customField' => 'plugin::stars.rating'],",
    );
  });

  it("names none for a field edited with its type's own input", () => {
    const attributes = contentManagerAttributes(
      [{ field: { type: "integer", name: "count" }, components: [], column: "count" }],
      [],
      [],
      [],
    );
    expect(attributes.find((a) => a.name === "count")).not.toHaveProperty("customField");
  });
});
