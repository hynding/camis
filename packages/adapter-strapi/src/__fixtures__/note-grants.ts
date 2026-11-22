import type { IrDocument } from "@camis/ir-schema";
import type { IrBundle, Role } from "@camis/permissions";

const document: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Note",
      kind: "collection",
      fields: [{ type: "string", name: "title" }],
      options: { draftPublish: false },
    },
  ],
  components: [],
};

const publicRead: Role = { name: "public", grants: [{ contentType: "Note", actions: ["read"] }] };

/** No grant carries a condition, so no conditions module is emitted. */
export const publicReadBundle: IrBundle = { document, roles: [publicRead] };

/** One grant carries a condition and one does not: its admin permission has no conditions. */
export const someConditionsBundle: IrBundle = {
  document,
  roles: [
    publicRead,
    {
      name: "authenticated",
      grants: [
        {
          contentType: "Note",
          actions: ["read"],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "user.id" },
            right: { kind: "lit", value: 1 },
          },
        },
      ],
    },
  ],
};
