import type { IrDocument } from "@camis/ir-schema";

/** Decimals stating their digits (issue #104): more than a double keeps, fewer, and none. */
export const decimals: IrDocument = {
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
      ],
    },
  ],
  components: [
    { name: "Limit", fields: [{ type: "decimal", name: "ceiling", precision: 18, scale: 2 }] },
  ],
};
