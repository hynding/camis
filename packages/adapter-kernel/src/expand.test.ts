import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { expandComponents } from "./expand";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Transaction",
      kind: "collection",
      fields: [
        { type: "string", name: "category" },
        { type: "component", name: "amount", component: "Money", repeatable: false },
      ],
    },
    {
      name: "Consumable",
      kind: "collection",
      fields: [
        { type: "string", name: "name" },
        { type: "component", name: "facts", component: "NutritionFacts", repeatable: false },
      ],
    },
    {
      name: "ActivitySession",
      kind: "collection",
      fields: [
        { type: "dateTime", name: "occurredAt" },
        { type: "component", name: "quantities", component: "Quantity", repeatable: true },
      ],
    },
  ],
  components: [
    {
      name: "Money",
      fields: [
        { type: "bigInteger", name: "minor", required: true },
        { type: "string", name: "currency", required: true },
      ],
    },
    {
      name: "ServingSize",
      fields: [
        { type: "decimal", name: "amount" },
        { type: "string", name: "unit" },
      ],
    },
    {
      name: "AdditionalNutrient",
      fields: [
        { type: "string", name: "slug" },
        { type: "decimal", name: "amount" },
      ],
    },
    {
      name: "NutritionFacts",
      fields: [
        { type: "decimal", name: "calories" },
        { type: "component", name: "servingSize", component: "ServingSize", repeatable: false },
        {
          type: "component",
          name: "additional",
          component: "AdditionalNutrient",
          repeatable: true,
        },
      ],
    },
    {
      name: "Quantity",
      fields: [
        { type: "decimal", name: "amount" },
        { type: "string", name: "unit" },
      ],
    },
  ],
};

const ct = (name: string) => doc.contentTypes.find((c) => c.name === name)!;

describe("expandComponents", () => {
  it("flattens a non-repeatable component into prefixed embedded scalars", () => {
    const r = expandComponents(doc, ct("Transaction"));
    expect(r.scalars.map((s) => s.path)).toEqual([
      ["amount", "minor"],
      ["amount", "currency"],
    ]);
    expect(r.scalars[0]?.field).toEqual({ type: "bigInteger", name: "minor", required: true });
    expect(r.tables).toEqual([]);
    expect(r.gaps).toEqual([]);
  });

  it("flattens nested non-repeatables and splits nested repeatables into tables", () => {
    const r = expandComponents(doc, ct("Consumable"));
    expect(r.scalars.map((s) => s.path)).toEqual([
      ["facts", "calories"],
      ["facts", "servingSize", "amount"],
      ["facts", "servingSize", "unit"],
    ]);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]?.path).toEqual(["facts", "additional"]);
    expect(r.tables[0]?.scalars.map((s) => s.path)).toEqual([["slug"], ["amount"]]);
  });

  it("turns a top-level repeatable component into a child table", () => {
    const r = expandComponents(doc, ct("ActivitySession"));
    expect(r.scalars).toEqual([]);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]?.path).toEqual(["quantities"]);
    expect(r.tables[0]?.scalars.map((s) => s.field.name)).toEqual(["amount", "unit"]);
  });

  it("reports a relation inside a component as a downgrade gap", () => {
    const withRel: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Post",
          kind: "collection",
          fields: [{ type: "component", name: "meta", component: "Meta", repeatable: false }],
        },
      ],
      components: [
        {
          name: "Meta",
          fields: [
            { type: "string", name: "title" },
            { type: "relation", name: "author", relationKind: "manyToOne", target: "Post" },
          ],
        },
      ],
    };
    const r = expandComponents(withRel, withRel.contentTypes[0]!);
    expect(r.scalars.map((s) => s.path)).toEqual([["meta", "title"]]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]?.feature).toBe("componentRelation");
    expect(r.gaps[0]?.severity).toBe("downgrade");
  });

  it("reports a repeatable nested inside a repeatable as a downgrade gap", () => {
    const nested: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Plan",
          kind: "collection",
          fields: [{ type: "component", name: "weeks", component: "Week", repeatable: true }],
        },
      ],
      components: [
        {
          name: "Week",
          fields: [
            { type: "string", name: "label" },
            { type: "component", name: "days", component: "Day", repeatable: true },
          ],
        },
        { name: "Day", fields: [{ type: "string", name: "note" }] },
      ],
    };
    const r = expandComponents(nested, nested.contentTypes[0]!);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]?.scalars.map((s) => s.field.name)).toEqual(["label"]);
    expect(r.gaps.map((g) => g.feature)).toEqual(["nestedRepeatable"]);
  });

  it("strips ai from component scalars and reports a downgrade gap", () => {
    const withAi: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Post",
          kind: "collection",
          fields: [{ type: "component", name: "meta", component: "Meta", repeatable: false }],
        },
      ],
      components: [
        {
          name: "Meta",
          fields: [
            {
              type: "text",
              name: "summary",
              ai: { prompt: "Summarize {{summary}}", trigger: "onCreateOrUpdate", model: "m" },
            },
          ],
        },
      ],
    };
    const r = expandComponents(withAi, withAi.contentTypes[0]!);
    expect(r.scalars).toHaveLength(1);
    expect((r.scalars[0]?.field as { ai?: unknown }).ai).toBeUndefined();
    expect(r.gaps.map((g) => g.feature)).toEqual(["componentAiField"]);
  });
});
