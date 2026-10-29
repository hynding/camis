import type { IrBundle } from "@camis/permissions";
import { catalog } from "./catalog";

// Gated-CI-only bundle: catalog's content/relations PLUS an Editor role with a record-level
// condition, so the boot job exercises migrations, relations, the Spatie seeder, and Policy
// enforcement in one app; Editor is the admin role and Reader is not, for the admin access check.
// Not golden-tested (it is free to combine).
export const bootBundle: IrBundle = {
  document: {
    ...catalog.document,
    hooks: [
      {
        name: "TransformTitle",
        trigger: "onPublish",
        contentType: "Article",
        input: [{ name: "title", type: "string" }],
        output: [{ name: "title", type: "string" }],
      },
    ],
  },
  roles: [
    {
      name: "Editor",
      admin: true,
      grants: [
        {
          contentType: "Article",
          actions: ["read", "update"],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "record.status" },
            right: { kind: "lit", value: "published" },
          },
        },
      ],
    },
    { name: "Reader", grants: [{ contentType: "Article", actions: ["read"] }] },
  ],
};
