import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { validateBundle } from "./validate";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
};

describe("validateBundle", () => {
  it("accepts grants and field rules that reference existing targets", () => {
    const r = validateBundle({
      document: doc,
      roles: [
        {
          name: "Ed",
          grants: [
            {
              contentType: "Article",
              actions: ["read"],
              fieldRules: [{ field: "title", access: "read" }],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects a grant on an unknown content type", () => {
    const r = validateBundle({
      document: doc,
      roles: [{ name: "Ed", grants: [{ contentType: "Ghost", actions: ["read"] }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("unknown_grant_content_type");
  });
  it("rejects a field rule on an unknown field", () => {
    const r = validateBundle({
      document: doc,
      roles: [
        {
          name: "Ed",
          grants: [
            {
              contentType: "Article",
              actions: ["read"],
              fieldRules: [{ field: "ghost", access: "read" }],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("unknown_field_rule_field");
  });
});

const ownedDoc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "User",
      kind: "collection",
      builtin: "user",
      fields: [{ type: "string", name: "username" }],
    },
    {
      name: "Note",
      kind: "collection",
      fields: [
        { type: "string", name: "text" },
        { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        { type: "relation", name: "tags", relationKind: "manyToMany", target: "Note" },
      ],
    },
  ],
  components: [],
};

describe("validateBundle assign", () => {
  it("accepts assign on an owning relation to the builtin user", () => {
    const r = validateBundle({
      document: ownedDoc,
      roles: [
        {
          name: "a",
          grants: [{ contentType: "Note", actions: ["create"], assign: { owner: "user.id" } }],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects assign on an unknown field", () => {
    const r = validateBundle({
      document: ownedDoc,
      roles: [
        {
          name: "a",
          grants: [{ contentType: "Note", actions: ["create"], assign: { nope: "user.id" } }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("unknown_assign_field");
  });
  it("rejects assign on a field that is not an owning relation to the builtin user", () => {
    const r = validateBundle({
      document: ownedDoc,
      roles: [
        {
          name: "a",
          grants: [{ contentType: "Note", actions: ["create"], assign: { tags: "user.id" } }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("assign_not_user_relation");
  });
  it("carries defaultRole through", () => {
    const r = validateBundle({ document: ownedDoc, roles: [], defaultRole: "a" });
    expect(r.ok && r.value.defaultRole).toBe("a");
  });
});
