import type { IrBundle } from "@camis/permissions";
import { catalog } from "./catalog";

// Gated-CI-only bundle: catalog's content/relations PLUS an Editor role with a record-level
// condition, so the boot job exercises migrations, relations, the Spatie seeder, and Policy
// enforcement in one app, with a hook on each kind of Ring 2 seam; Editor is the admin role and Reader is not, for the admin access check.
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
      {
        name: "DefaultStatus",
        trigger: "beforeCreate",
        contentType: "Article",
        input: [{ name: "title", type: "string" }],
        output: [{ name: "status", type: "string" }],
      },
      {
        name: "ForgetArticle",
        trigger: "afterDelete",
        contentType: "Article",
        input: [{ name: "title", type: "string" }],
        output: [],
      },
    ],
    policies: [{ name: "NoDeletes", contentType: "Article", actions: ["delete"] }],
    middlewares: [{ name: "TagResponse", contentType: "Article", actions: ["list"] }],
    schedules: [{ name: "Heartbeat", cron: "* * * * *" }],
  },
  roles: [
    {
      name: "Editor",
      admin: true,
      grants: [
        {
          contentType: "Article",
          actions: ["read", "update", "delete"],
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
