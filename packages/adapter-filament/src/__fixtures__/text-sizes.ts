import type { IrBundle } from "@camis/permissions";

/**
 * Text fields of every size class (issue #123): MySQL's TEXT holds 65,535 bytes, so a bound or no
 * bound at all must pick a larger column. `unbounded` states a bound no MySQL text holds. CI's
 * text-columns job overlays it (scripts/overlay.ts --bundle text-sizes) and runs TextSizesTest,
 * which stores and reads back values past 64 KiB, on SQLite, MySQL and PostgreSQL.
 */
export const textSizesBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Page",
        kind: "collection",
        names: { plural: "Pages" },
        fields: [
          { type: "string", name: "title" },
          { type: "text", name: "summary", maxLength: 1000 },
          { type: "text", name: "chapter", maxLength: 524288 },
          { type: "text", name: "body" },
          { type: "richText", name: "markdown" },
          { type: "text", name: "unbounded", maxLength: 1073741824 },
        ],
      },
    ],
    components: [],
  },
  roles: [],
};
