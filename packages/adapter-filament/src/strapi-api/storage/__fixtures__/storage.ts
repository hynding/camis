import type { IrBundle } from "@camis/permissions";

const ownerEq = {
  kind: "eq",
  left: { kind: "var", name: "record.ownerId" },
  right: { kind: "var", name: "user.id" },
} as const;
const creatorEq = {
  kind: "eq",
  left: { kind: "var", name: "record.creatorId" },
  right: { kind: "var", name: "user.id" },
} as const;
const assigneeEq = {
  kind: "eq",
  left: { kind: "var", name: "record.assigneeId" },
  right: { kind: "var", name: "user.id" },
} as const;

/**
 * Fixture for the Strapi physical-storage naming layer (Task 5). Modeled on
 * `strapi-api/__fixtures__/strapi-api.ts`'s role/condition style, extended with the component
 * shapes (non-repeatable, repeatable, nested-both-ways) and the `inverse` relation that Task 5's
 * naming functions need to exercise. Later tasks reuse this fixture for PHP goldens, so keep it
 * stable.
 */
export const storageBundle: IrBundle = {
  defaultRole: "authenticated",
  document: {
    version: 1,
    contentTypes: [
      {
        name: "User",
        kind: "collection",
        builtin: "user",
        fields: [
          { type: "string", name: "username", required: true, unique: true },
          { type: "email", name: "email", required: true },
        ],
      },
      {
        name: "Note",
        kind: "collection",
        names: { plural: "Notes", collection: "notes" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "text", name: "text", required: true },
          { type: "dateTime", name: "occurredAt", required: true },
          { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        ],
      },
      {
        name: "Transaction",
        kind: "collection",
        names: { plural: "Transactions" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "component", name: "amount", component: "Money", repeatable: false },
          { type: "decimal", name: "fee" },
          { type: "date", name: "occurredOn" },
          { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        ],
      },
      {
        name: "ActivitySession",
        kind: "collection",
        names: { plural: "ActivitySessions" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "component", name: "quantities", component: "Quantity", repeatable: true },
          { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        ],
      },
      {
        name: "Consumable",
        kind: "collection",
        names: { plural: "Consumables" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "relation", name: "creator", relationKind: "manyToOne", target: "User" },
          { type: "component", name: "facts", component: "NutritionFacts", repeatable: false },
        ],
      },
      {
        name: "Task",
        kind: "collection",
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "string", name: "title", required: true },
          {
            type: "relation",
            name: "assignee",
            relationKind: "manyToOne",
            target: "User",
            inverse: "tasks",
          },
        ],
      },
    ],
    components: [
      {
        name: "Money",
        names: { collection: "components_finance_money", group: "finance" },
        fields: [
          { type: "bigInteger", name: "minor" },
          { type: "string", name: "currency" },
        ],
      },
      {
        name: "Quantity",
        names: { collection: "components_activity_quantities", group: "activity" },
        fields: [
          { type: "decimal", name: "amount" },
          { type: "string", name: "unit" },
        ],
      },
      {
        name: "NutritionFacts",
        names: { collection: "components_nutrition_nutrition_facts", group: "nutrition" },
        fields: [
          { type: "integer", name: "calories" },
          {
            type: "component",
            name: "servingSize",
            component: "ServingSize",
            repeatable: false,
          },
          { type: "component", name: "additional", component: "Nutrient", repeatable: true },
        ],
      },
      {
        name: "ServingSize",
        fields: [{ type: "decimal", name: "amount" }],
      },
      {
        name: "Nutrient",
        names: { collection: "components_nutrition_additional_nutrients", group: "nutrition" },
        fields: [
          { type: "string", name: "slug" },
          { type: "decimal", name: "amount" },
        ],
      },
    ],
  },
  roles: [
    {
      name: "authenticated",
      grants: [
        {
          contentType: "Note",
          actions: ["create", "read", "update", "delete"],
          condition: ownerEq,
          assign: { owner: "user.id" },
        },
        {
          contentType: "Transaction",
          actions: ["create", "read", "update", "delete"],
          condition: ownerEq,
          assign: { owner: "user.id" },
        },
        {
          contentType: "ActivitySession",
          actions: ["create", "read", "update", "delete"],
          condition: ownerEq,
          assign: { owner: "user.id" },
        },
        {
          contentType: "Consumable",
          actions: ["create", "read", "update", "delete"],
          condition: creatorEq,
          assign: { creator: "user.id" },
        },
        {
          contentType: "Task",
          actions: ["create", "read", "update", "delete"],
          condition: assigneeEq,
          assign: { assignee: "user.id" },
        },
      ],
    },
  ],
};
