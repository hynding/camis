import type { IrBundle } from "@camis/permissions";

/**
 * String fields of every column class (issue #126): no bound, a bound a string column holds, a
 * bound past 255 characters in a text column of each tier, and unique strings, whose column an
 * index key bounds. `handle` and `unbounded` state bounds no column holds. `tagline` and `summary`
 * have defaults their text columns cannot take on MySQL, which the model applies. CI's text-columns job
 * overlays it (scripts/overlay.ts --bundle string-sizes) and runs StringSizesTest, which stores and
 * reads back values of four-byte characters at their bounds, on SQLite, MySQL and PostgreSQL.
 */
export const stringSizesBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Entry",
        kind: "collection",
        names: { plural: "Entries" },
        fields: [
          { type: "string", name: "title" },
          { type: "string", name: "code", maxLength: 40 },
          { type: "string", name: "headline", maxLength: 1000 },
          { type: "string", name: "abstract", maxLength: 20000 },
          { type: "email", name: "contact", maxLength: 320 },
          { type: "string", name: "slug", unique: true, maxLength: 300 },
          { type: "string", name: "handle", unique: true, maxLength: 1000 },
          { type: "string", name: "unbounded", maxLength: 1073741824 },
          { type: "string", name: "label", maxLength: 100, default: "hi" },
          { type: "string", name: "tagline", maxLength: 500, default: "hello" },
          { type: "text", name: "summary", default: "none" },
        ],
      },
    ],
    components: [],
  },
  roles: [],
};
