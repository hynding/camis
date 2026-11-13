import type { IrBundle } from "@camis/permissions";

/**
 * Unique fields inside components, at every depth Strapi checks them: an embedded component, a
 * repeatable's items and what they embed, a repeatable inside one, a repeatable inside an embedded
 * component, and a dynamic zone's components (Strapi checks no deeper there). CI's
 * unique-components job overlays it (scripts/overlay.ts --bundle unique-components) and runs
 * UniqueComponentsTest, whose answers were recorded from strapi-php.
 */
export const uniqueComponentsBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Event",
        kind: "collection",
        names: { plural: "Events" },
        fields: [
          { type: "string", name: "title" },
          { type: "component", name: "badge", component: "Badge", repeatable: false },
          { type: "component", name: "slots", component: "Slot", repeatable: true },
          { type: "component", name: "info", component: "Info", repeatable: false },
          { type: "dynamicZone", name: "blocks", components: ["Badge", "Slot"] },
        ],
      },
    ],
    components: [
      { name: "Badge", fields: [{ type: "string", name: "code", unique: true }] },
      {
        name: "Slot",
        fields: [
          { type: "string", name: "label" },
          { type: "component", name: "badge", component: "Badge", repeatable: false },
          { type: "component", name: "seats", component: "Badge", repeatable: true },
        ],
      },
      {
        name: "Info",
        fields: [{ type: "component", name: "passes", component: "Badge", repeatable: true }],
      },
    ],
  },
  roles: [
    {
      name: "authenticated",
      grants: [{ contentType: "Event", actions: ["create", "read", "update", "delete"] }],
    },
  ],
};
