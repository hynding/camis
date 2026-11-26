import type { IrBundle } from "@camis/permissions";
import { catalog } from "./catalog";

// Gated-CI-only bundle: catalog's content/relations PLUS an Editor role with a record-level
// condition, so the boot job exercises migrations, relations, the Spatie seeder, and Policy
// enforcement in one app, with a hook on each kind of Ring 2 seam; Editor is the admin role and Reader is not, for the admin access check.
// Not golden-tested (it is free to combine). Article's balance, a decimal beyond a double, is
// round tripped through the API on each database (issue #104), and its subtitle, a string bounded
// past what a VARCHAR is given, keeps its bound in four-byte characters and refuses one more (#126).
export const bootBundle: IrBundle = {
  document: {
    ...catalog.document,
    contentTypes: catalog.document.contentTypes.map((ct) =>
      ct.name === "Article"
        ? {
            ...ct,
            fields: [
              ...ct.fields,
              { type: "decimal", name: "balance", precision: 20, scale: 6 } as const,
              { type: "string", name: "subtitle", maxLength: 1000 } as const,
            ],
          }
        : ct,
    ),
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
