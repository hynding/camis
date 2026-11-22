import type { IrBundle } from "@camis/permissions";

/**
 * Decimals stating their digits (issue #104): `balance`, `share`, a limit's `ceiling` and an
 * entry's `amount` keep more digits than PHP writes a float with (14), `units` exactly those and
 * `rate` fewer, and `fee` states none, keeping the target's default; the `lines` zone holds limits.
 * CI's boot job round trips `balance` on the Laravel API style (the boot
 * fixture holds it too), its decimals job this fixture on the Strapi API style
 * (scripts/overlay.ts --bundle decimals, DecimalsTest), each on SQLite, MySQL and PostgreSQL.
 */
export const decimalsBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Ledger",
        kind: "collection",
        fields: [
          { type: "string", name: "label" },
          { type: "decimal", name: "balance", precision: 20, scale: 6 },
          { type: "decimal", name: "rate", precision: 9, scale: 4 },
          { type: "decimal", name: "share", precision: 15, scale: 5 },
          { type: "decimal", name: "units", precision: 14, scale: 4 },
          { type: "decimal", name: "fee" },
          { type: "component", name: "limit", component: "Limit", repeatable: false },
          { type: "component", name: "entries", component: "Entry", repeatable: true },
          { type: "dynamicZone", name: "lines", components: ["Limit"] },
        ],
      },
    ],
    components: [
      { name: "Limit", fields: [{ type: "decimal", name: "ceiling", precision: 18, scale: 2 }] },
      {
        name: "Entry",
        fields: [
          { type: "string", name: "memo" },
          { type: "decimal", name: "amount", precision: 20, scale: 6 },
        ],
      },
    ],
  },
  roles: [
    {
      name: "authenticated",
      grants: [{ contentType: "Ledger", actions: ["create", "read", "update", "delete"] }],
    },
  ],
};
