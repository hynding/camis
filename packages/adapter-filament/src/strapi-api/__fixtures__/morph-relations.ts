import type { IrBundle } from "@camis/permissions";

/**
 * Strapi's polymorphic relations: a note's subjects (morphToMany) and what it is pinned to
 * (morphToOne) link entries of any type; a book reads the notes pinned to it and the notes naming
 * it as a subject, a film the one note pinned to it (morphMany, morphOne). A secret is a type the
 * authenticated role may not read, which a note's links leave out. CI's morph-relations job
 * overlays it (scripts/overlay.ts --bundle morph-relations) and runs MorphRelationsTest, whose
 * answers were recorded from strapi-php.
 */
export const morphRelationsBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Note",
        kind: "collection",
        options: { draftPublish: true },
        fields: [
          { type: "string", name: "title" },
          { type: "polymorphicRelation", name: "subjects", many: true },
          {
            type: "polymorphicRelation",
            name: "pinnedTo",
            names: { api: "pinned_to" },
            many: false,
          },
        ],
      },
      {
        name: "Book",
        kind: "collection",
        fields: [
          { type: "string", name: "title" },
          {
            type: "polymorphicInverse",
            name: "pins",
            target: "Note",
            via: "pinnedTo",
            viaNames: { api: "pinned_to" },
            many: true,
          },
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
          {
            type: "polymorphicInverse",
            name: "pin",
            target: "Note",
            via: "pinnedTo",
            viaNames: { api: "pinned_to" },
            many: false,
          },
        ],
      },
      { name: "Secret", kind: "collection", fields: [{ type: "string", name: "title" }] },
    ],
    components: [],
  },
  roles: [
    {
      name: "authenticated",
      grants: [
        { contentType: "Note", actions: ["create", "read", "update", "delete"] },
        { contentType: "Book", actions: ["create", "read", "update", "delete"] },
        { contentType: "Film", actions: ["create", "read", "update", "delete"] },
      ],
    },
  ],
};
