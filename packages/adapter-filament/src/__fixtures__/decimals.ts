import type { IrBundle } from "@camis/permissions";

/**
 * Decimals stating their digits (issue #104): `balance` and an entry's `amount` keep more digits
 * than a double does, `rate` and a limit's `ceiling` fewer, and `fee` states none, keeping the
 * target's default. CI's boot job round trips `balance` on the Laravel API style (the boot
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
          { type: "decimal", name: "fee" },
          { type: "component", name: "limit", component: "Limit", repeatable: false },
          { type: "component", name: "entries", component: "Entry", repeatable: true },
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
