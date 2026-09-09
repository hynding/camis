import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { storageBundle } from "./__fixtures__/storage";
import {
  cmpsTable,
  componentTable,
  componentType,
  linkColumns,
  linkTable,
  strapiSingular,
  strapiTable,
  type RelationField,
} from "./names";

const ct = (name: string): ContentType => {
  const found = storageBundle.document.contentTypes.find((c) => c.name === name);
  if (!found) throw new Error(`fixture missing content type ${name}`);
  return found;
};
const relation = (typeName: string, fieldName: string): RelationField => {
  const found = ct(typeName).fields.find((f) => f.name === fieldName);
  if (!found || found.type !== "relation") throw new Error(`fixture missing relation ${fieldName}`);
  return found;
};
const component = (name: string) => {
  const found = storageBundle.document.components.find((c) => c.name === name);
  if (!found) throw new Error(`fixture missing component ${name}`);
  return found;
};

describe("strapiTable", () => {
  it("uses names.collection when present", () => {
    expect(strapiTable(ct("Note"))).toBe("notes");
  });
  it("defaults to snake(names.plural ?? pluralize(name)) when names.collection is absent", () => {
    expect(strapiTable(ct("Transaction"))).toBe("transactions");
    expect(strapiTable(ct("Task"))).toBe("tasks");
  });
});

describe("strapiSingular", () => {
  it("is snake(ct.name)", () => {
    expect(strapiSingular(ct("ActivitySession"))).toBe("activity_session");
  });
});

describe("linkTable", () => {
  it("is `${table}_${snake(relation)}_lnk`", () => {
    expect(linkTable(ct("Note"), "owner")).toBe("notes_owner_lnk");
  });
});

describe("linkColumns", () => {
  it("has local/foreign columns, and ord only when the relation has an inverse", () => {
    expect(linkColumns(ct("Task"), relation("Task", "assignee"))).toEqual({
      local: "task_id",
      foreign: "user_id",
      ord: "task_ord",
    });
  });
  it("omits ord (not undefined) when there is no inverse", () => {
    const cols = linkColumns(ct("Note"), relation("Note", "owner"));
    expect(cols).toEqual({ local: "note_id", foreign: "user_id" });
    expect(cols.ord).toBeUndefined();
    expect("ord" in cols).toBe(false);
  });
});

describe("cmpsTable", () => {
  it("appends _cmps to a table name", () => {
    expect(cmpsTable("consumables")).toBe("consumables_cmps");
  });
});

describe("componentTable", () => {
  it("uses names.collection when present", () => {
    expect(componentTable(component("Money"))).toBe("components_finance_money");
  });
  it("defaults to components_shared_<snake plural> when absent", () => {
    expect(componentTable(component("ServingSize"))).toBe("components_shared_serving_sizes");
  });
});

describe("componentType", () => {
  it("is `${names.group}.${kebab(name)}`", () => {
    expect(componentType(component("NutritionFacts"))).toBe("nutrition.nutrition-facts");
  });
  it("defaults to group shared when names.group is absent", () => {
    expect(componentType(component("ServingSize"))).toBe("shared.serving-size");
  });
});
