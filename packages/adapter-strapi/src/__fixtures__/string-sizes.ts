import type { IrDocument } from "@camis/ir-schema";

/**
 * String fields of every column class (issue #126): Strapi makes a string a varchar(255) whatever
 * its bound, so a longer bound needs column settings; `handle` and `unbounded` state bounds no
 * column holds.
 */
export const stringSizes: IrDocument = {
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
      ],
    },
  ],
  components: [],
};
