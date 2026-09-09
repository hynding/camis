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
    {
      name: "Invoice",
      kind: "collection",
      fields: [
        {
          type: "component",
          name: "total",
          component: "Money",
          repeatable: false,
          required: true,
        },
        { type: "component", name: "discount", component: "Money", repeatable: false },
      ],
    },
    {
      name: "Shipment",
      kind: "collection",
      fields: [
        {
          type: "component",
          name: "loose",
          component: "OptionalMoneyEnvelope",
          repeatable: false,
          required: true,
        },
        {
          type: "component",
          name: "firm",
          component: "RequiredMoneyEnvelope",
          repeatable: false,
          required: true,
        },
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
        { type: "decimal", name: "amount", required: true },
        { type: "string", name: "unit", required: true },
      ],
    },
    {
      name: "AdditionalNutrient",
      fields: [
        { type: "string", name: "slug", required: true },
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
      name: "OptionalMoneyEnvelope",
      fields: [{ type: "component", name: "inner", component: "Money", repeatable: false }],
    },
    {
      name: "RequiredMoneyEnvelope",
      fields: [
        {
          type: "component",
          name: "inner",
          component: "Money",
          repeatable: false,
          required: true,
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
    // Transaction.amount is itself optional, so the column cannot be NOT NULL — but the IR's
    // own `required` survives on the field for the validation layer to use.
    expect(r.scalars[0]?.field).toEqual({ type: "bigInteger", name: "minor", required: true });
    expect(r.scalars[0]?.alwaysPresent).toBe(false);
    expect(r.tables).toEqual([]);
    expect(r.gaps).toEqual([]);
  });

  // A flattened column is shared by the whole embedded component: when the component reference
  // is optional the component may simply be absent, and a NOT NULL column then rejects every
  // record without it (SQLSTATE 23000 on insert). Required-ness inside an optional component
  // constrains the component when present, which is a validation concern, not a column one —
  // so `alwaysPresent` carries the column answer and `field.required` stays untouched.
  it("marks a scalar alwaysPresent only when every enclosing component reference is required", () => {
    const r = expandComponents(doc, ct("Invoice"));
    expect(r.scalars.map((s) => [s.path, s.alwaysPresent])).toEqual([
      [["total", "minor"], true],
      [["total", "currency"], true],
      [["discount", "minor"], false],
      [["discount", "currency"], false],
    ]);
    // The IR constraint is preserved on every scalar regardless of the column answer.
    expect(r.scalars.map((s) => s.field.required)).toEqual([true, true, true, true]);
  });

  it("clears alwaysPresent as soon as one link in a nested path is optional", () => {
    const r = expandComponents(doc, ct("Consumable"));
    const servingSize = r.scalars.filter((s) => s.path[1] === "servingSize");
    expect(servingSize.map((s) => s.path[2])).toEqual(["amount", "unit"]);
    for (const s of servingSize) {
      expect(s.alwaysPresent).toBe(false);
      expect(s.field.required).toBe(true);
    }
  });

  it("clears alwaysPresent for a required outer reference through an optional inner one", () => {
    const r = expandComponents(doc, ct("Shipment"));
    const loose = r.scalars.filter((s) => s.path[0] === "loose");
    expect(loose.map((s) => s.path)).toEqual([
      ["loose", "inner", "minor"],
      ["loose", "inner", "currency"],
    ]);
    for (const s of loose) {
      expect(s.alwaysPresent).toBe(false);
      expect(s.field.required).toBe(true);
    }
  });

  it("keeps alwaysPresent when every reference on a depth-2 path is required", () => {
    const r = expandComponents(doc, ct("Shipment"));
    const firm = r.scalars.filter((s) => s.path[0] === "firm");
    expect(firm.map((s) => s.path)).toEqual([
      ["firm", "inner", "minor"],
      ["firm", "inner", "currency"],
    ]);
    for (const s of firm) {
      expect(s.alwaysPresent).toBe(true);
      expect(s.field.required).toBe(true);
    }
  });

  // A child-table row exists only when the repeatable item does, so required-ness inside it is
  // a genuine NOT NULL — nothing is being made optional by the parent reference here.
  it("keeps required inside a repeatable component's child table", () => {
    const r = expandComponents(doc, ct("Consumable"));
    expect(
      r.tables[0]?.scalars.map((s) => [s.field.name, s.field.required, s.alwaysPresent]),
    ).toEqual([
      ["slug", true, true],
      ["amount", undefined, true],
    ]);
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
