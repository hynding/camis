import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { storageBundle } from "./__fixtures__/storage";
import { componentMap } from "./component-map";

const ct = (name: string): ContentType => {
  const found = storageBundle.document.contentTypes.find((c) => c.name === name);
  if (!found) throw new Error(`fixture missing content type ${name}`);
  return found;
};

describe("componentMap", () => {
  it("Transaction: single non-repeatable component, flat-prefixed scalars", () => {
    const map = componentMap(storageBundle.document, ct("Transaction"));
    expect(map).toHaveLength(1);
    const amount = map[0]!;
    expect(amount.field).toBe("amount");
    expect(amount.repeatable).toBe(false);
    expect(amount.relationName).toBeUndefined();
    expect(amount.wireKey).toEqual(["amount"]);
    expect(amount.flatPrefix).toEqual(["amount"]);
    expect(amount.table).toBe("components_finance_money");
    expect(amount.type).toBe("finance.money");
    expect(amount.cmpsTable).toBe("transactions_cmps");
    expect(amount.scalars.map((s) => [s.column, s.flatAttribute, s.type])).toEqual([
      ["minor", "amount_minor", "bigInteger"],
      ["currency", "amount_currency", "string"],
    ]);
    expect(amount.nested).toEqual([]);
  });

  it("ActivitySession: repeatable component gets a Phase-16 relation name", () => {
    const map = componentMap(storageBundle.document, ct("ActivitySession"));
    expect(map).toHaveLength(1);
    const quantities = map[0]!;
    expect(quantities.field).toBe("quantities");
    expect(quantities.repeatable).toBe(true);
    expect(quantities.relationName).toBe("quantities");
    expect(quantities.wireKey).toEqual(["quantities"]);
    expect(quantities.table).toBe("components_activity_quantities");
    expect(quantities.type).toBe("activity.quantity");
    expect(quantities.cmpsTable).toBe("activity_sessions_cmps");
    expect(quantities.scalars.map((s) => [s.column, s.flatAttribute])).toEqual([
      ["amount", "amount"],
      ["unit", "unit"],
    ]);
  });

  it("Consumable: nested non-repeatable and repeatable components under one component field", () => {
    const map = componentMap(storageBundle.document, ct("Consumable"));
    expect(map).toHaveLength(1);
    const facts = map[0]!;
    expect(facts.field).toBe("facts");
    expect(facts.repeatable).toBe(false);
    expect(facts.wireKey).toEqual(["facts"]);
    expect(facts.flatPrefix).toEqual(["facts"]);
    expect(facts.table).toBe("components_nutrition_nutrition_facts");
    expect(facts.type).toBe("nutrition.nutrition-facts");
    expect(facts.cmpsTable).toBe("consumables_cmps");
    expect(facts.scalars).toEqual([
      {
        wireKey: ["facts", "calories"],
        flatAttribute: "facts_calories",
        column: "calories",
        type: "integer",
      },
    ]);
    expect(facts.nested).toHaveLength(2);

    const [servingSize, additional] = facts.nested;
    expect(servingSize!.field).toBe("servingSize");
    expect(servingSize!.repeatable).toBe(false);
    expect(servingSize!.relationName).toBeUndefined();
    expect(servingSize!.wireKey).toEqual(["facts", "servingSize"]);
    expect(servingSize!.flatPrefix).toEqual(["facts", "serving_size"]);
    expect(servingSize!.table).toBe("components_shared_serving_sizes");
    expect(servingSize!.type).toBe("shared.serving-size");
    expect(servingSize!.cmpsTable).toBe("components_nutrition_nutrition_facts_cmps");
    expect(servingSize!.scalars).toEqual([
      {
        wireKey: ["facts", "servingSize", "amount"],
        flatAttribute: "facts_serving_size_amount",
        column: "amount",
        type: "decimal",
      },
    ]);
    expect(servingSize!.nested).toEqual([]);

    expect(additional!.field).toBe("additional");
    expect(additional!.repeatable).toBe(true);
    expect(additional!.relationName).toBe("factsAdditional");
    expect(additional!.wireKey).toEqual(["facts", "additional"]);
    expect(additional!.table).toBe("components_nutrition_additional_nutrients");
    expect(additional!.type).toBe("nutrition.nutrient");
    expect(additional!.cmpsTable).toBe("components_nutrition_nutrition_facts_cmps");
    expect(additional!.scalars).toEqual([
      {
        wireKey: ["facts", "additional", "slug"],
        flatAttribute: "slug",
        column: "slug",
        type: "string",
      },
      {
        wireKey: ["facts", "additional", "amount"],
        flatAttribute: "amount",
        column: "amount",
        type: "decimal",
      },
    ]);
    expect(additional!.nested).toEqual([]);
  });

  it("Task: a content type with no component fields maps to an empty array", () => {
    expect(componentMap(storageBundle.document, ct("Task"))).toEqual([]);
  });
});
