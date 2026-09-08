import type { Expression } from "@camis/expr";
import type { IrBundle } from "@camis/permissions";

const ownerEq = {
  kind: "eq",
  left: { kind: "var", name: "record.ownerId" },
  right: { kind: "var", name: "user.id" },
} as const;
const publicOrMine: Expression = {
  kind: "or",
  args: [
    {
      kind: "eq",
      left: { kind: "var", name: "record.visibility" },
      right: { kind: "lit", value: "public" },
    },
    {
      kind: "eq",
      left: { kind: "var", name: "record.creatorId" },
      right: { kind: "var", name: "user.id" },
    },
  ],
};

export const strapiApiBundle: IrBundle = {
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
        names: { plural: "Notes" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "text", name: "text", required: true },
          { type: "json", name: "tags" },
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
        name: "Activity",
        kind: "collection",
        names: { plural: "Activities" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "string", name: "name", required: true },
          {
            type: "enumeration",
            name: "visibility",
            values: ["private", "public"],
            default: "public",
          },
          { type: "relation", name: "creator", relationKind: "manyToOne", target: "User" },
        ],
      },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
    ],
    components: [
      {
        name: "Money",
        fields: [
          { type: "bigInteger", name: "minor" },
          { type: "string", name: "currency" },
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
          contentType: "Activity",
          actions: ["create", "read", "update", "delete"],
          condition: publicOrMine,
          assign: { creator: "user.id" },
        },
        { contentType: "Tag", actions: ["read"] },
      ],
    },
  ],
};
