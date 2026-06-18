import type { IrBundle } from "@camis/permissions";
import { catalog } from "./catalog";

// Gated-CI-only bundle: catalog's content/relations PLUS an Editor role with a record-level
// condition, so the boot job exercises migrations, relations, the Spatie seeder, and Policy
// enforcement in one app. Not golden-tested (it is free to combine).
export const bootBundle: IrBundle = {
  document: catalog.document,
  roles: [
    {
      name: "Editor",
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
  ],
};
