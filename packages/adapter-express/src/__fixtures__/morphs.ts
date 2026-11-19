import type { IrBundle } from "@camis/permissions";

/**
 * Polymorphic relations: a note's subjects (to-many) and what it is pinned to (to-one) link
 * entries of any type; a book reads the notes pinned to it and naming it, a film the one note
 * pinned to it. A secret is a type the Planner may not read: a note the Keeper links to one shows
 * the Planner its other links only.
 */
export const morphs: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Note",
        kind: "collection",
        fields: [
          { type: "string", name: "title" },
          { type: "polymorphicRelation", name: "subjects", many: true },
          { type: "polymorphicRelation", name: "pinnedTo", many: false },
        ],
      },
      {
        name: "Book",
        kind: "collection",
        fields: [
          { type: "string", name: "title" },
          { type: "polymorphicInverse", name: "pins", target: "Note", via: "pinnedTo", many: true },
          {
            type: "polymorphicInverse",
            name: "remarks",
            target: "Note",
            via: "subjects",
            many: true,
          },
        ],
      },
      {
        name: "Film",
        kind: "collection",
        fields: [
          { type: "string", name: "title" },
          { type: "polymorphicInverse", name: "pin", target: "Note", via: "pinnedTo", many: false },
        ],
      },
      { name: "Secret", kind: "collection", fields: [{ type: "string", name: "title" }] },
    ],
    components: [],
  },
  roles: [
    {
      name: "Planner",
      grants: [
        { contentType: "Note", actions: ["create", "read", "update", "delete"] },
        { contentType: "Book", actions: ["create", "read", "update", "delete"] },
        { contentType: "Film", actions: ["create", "read", "update", "delete"] },
      ],
    },
    {
      name: "Keeper",
      grants: [
        { contentType: "Secret", actions: ["create", "read", "update", "delete"] },
        { contentType: "Note", actions: ["create", "read"] },
        { contentType: "Book", actions: ["read"] },
      ],
    },
  ],
};
