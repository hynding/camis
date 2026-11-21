import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { ownershipBundle } from "../__fixtures__/ownership";
import { projectApiEnforcement } from "./api-enforcement";

const { document: doc, roles } = ownershipBundle;
const v = (name: string): Expression => ({ kind: "var", name });
const owned: Expression = { kind: "eq", left: v("record.ownerId"), right: v("user.id") };

const errors = (d: IrDocument, rs: Role[]) =>
  projectApiEnforcement(d, rs).gaps.filter((g) => g.severity === "error");

describe("projectApiEnforcement", () => {
  const out = projectApiEnforcement(doc, roles);
  const note = out.types.find((t) => t.contentType === "Note")!;

  it("enforces each type a non-admin role holds under a condition or an assign", () => {
    expect(note.uid).toBe("api::note.note");
    expect(note.own).toBe(true);
  });
  // A type that reaches a conditioned type through a relation serves that type's rows in a
  // populate, a relation filter or a relation write, so it gets a controller of its own too.
  it("also serves every collection type that reaches a conditioned type, with no rules of its own", () => {
    expect(out.types.map((t) => [t.contentType, t.own])).toEqual([
      ["Note", true],
      ["Tag", false],
    ]);
    expect(out.types.find((t) => t.contentType === "Tag")!.roles).toEqual({});
  });
  it("maps how each holder reaches a conditioned type: relations, inverses, components", () => {
    expect(out.holders).toEqual({
      "api::tag.tag": {
        populatable: ["note", "parent", "refs"],
        links: {
          note: { relation: "api::note.note" },
          parent: { relation: "api::tag.tag" },
          refs: { component: "shared.reference" },
        },
      },
      "shared.reference": {
        populatable: ["note"],
        links: { note: { relation: "api::note.note" } },
      },
    });
  });
  it("names the field defaults a create condition reads, which Strapi fills when omitted", () => {
    expect(note.defaults).toEqual({ "record.shared": true });
  });
  // Two types may share a condition's predicate but not its field types: each type compiles its
  // own filter.
  it("compiles each type's filter for its own fields, even when types share a predicate", () => {
    const status: Expression = {
      kind: "eq",
      left: v("record.status"),
      right: { kind: "lit", value: "open" },
    };
    const two: IrDocument = {
      version: 1,
      components: [],
      contentTypes: [
        { name: "A", kind: "collection", fields: [{ type: "string", name: "status" }] },
        { name: "B", kind: "collection", fields: [{ type: "integer", name: "status" }] },
      ],
    };
    const result = projectApiEnforcement(two, [
      {
        name: "member",
        grants: [
          { contentType: "A", actions: ["read"], condition: status },
          { contentType: "B", actions: ["update"], condition: status },
        ],
      },
    ]);
    const a = result.types.find((t) => t.contentType === "A")!;
    expect(a.conditions.map((c) => c.filter)).toEqual([
      { kind: "eq", variable: "record.status", value: { kind: "literal", value: "open" } },
    ]);
    expect(
      result.types.find((t) => t.contentType === "B")!.conditions.map((c) => c.filter),
    ).toEqual([null]);
  });
  it("keeps per role how it holds each action: outright, or under its conditions", () => {
    const member = note.roles.member!;
    expect(member.assign).toEqual(["owner"]);
    expect(member.read).toHaveLength(1);
    expect(member.create).toEqual(member.read);
    expect(member.update).toEqual(member.read);
    expect(member.delete).toEqual(member.read);
    expect(note.roles.reviewer).toEqual({
      read: true,
      update: [expect.stringMatching(/^camis-cond-/)],
      delete: [expect.stringMatching(/^camis-cond-/)],
      assign: [],
    });
    expect(note.roles.public!.read).toHaveLength(1);
    expect(note.roles.public!.update).toBeUndefined();
    expect(note.admins).toEqual(["manager"]);
  });
  it("loads only the record variables its conditions read", () => {
    expect(note.variables).toEqual({
      "record.ownerId": { field: "owner", relation: true },
      "record.shared": { field: "shared", relation: false },
    });
  });
  it("gives each condition its Ring 1 predicate and, for a list, its row filter", () => {
    const byPredicate = (p: Expression) =>
      note.conditions.find((c) => JSON.stringify(c.predicate) === JSON.stringify(p));
    expect(byPredicate(owned)?.filter).toEqual({
      kind: "eq",
      variable: "record.ownerId",
      value: { kind: "user", variable: "user.id" },
    });
  });
  it("assigns, for callers with no role, every field some grant assigns", () => {
    expect(note.assign).toEqual(["owner"]);
  });
  it("reports no error for an enforceable model", () => {
    expect(out.gaps.filter((g) => g.severity === "error")).toEqual([]);
  });
  it("reports no populate gap: the reach is enforced", () => {
    expect(out.gaps.map((g) => g.feature)).not.toContain("apiPopulateScope");
  });
  it("leaves an admin role's condition to the admin panel, as a downgrade", () => {
    const admin: Role = {
      name: "editor",
      admin: true,
      grants: [{ contentType: "Note", actions: ["read"], condition: owned }],
    };
    const result = projectApiEnforcement(doc, [admin]);
    expect(result.types).toEqual([]);
    expect(result.holders).toEqual({});
    expect(result.gaps).toEqual([
      {
        feature: "apiGrantCondition",
        location: { contentType: "Note", rule: "editor" },
        severity: "downgrade",
        message:
          '"editor" is an admin role, which the content API does not restrict: its condition on "Note" applies to the admin panel only',
      },
    ]);
  });
});

describe("conditions the Strapi content API cannot enforce fail the build", () => {
  const grant = (
    contentType: string,
    actions: Role["grants"][number]["actions"],
    condition: Expression,
  ): Role[] => [{ name: "member", grants: [{ contentType, actions, condition }] }];

  it("a read condition with no row filter (outside eq/and/or over record.* vs literal or user.*)", () => {
    const not: Expression = { kind: "not", arg: v("record.shared") };
    expect(errors(doc, grant("Note", ["read"], not))).toEqual([
      {
        feature: "apiGrantCondition",
        location: { contentType: "Note", rule: "member" },
        severity: "error",
        message:
          'role "member" reads "Note" under a condition the Strapi content API cannot filter a list by (only eq/and/or over record.<field> or record.<relation>Id against a literal or user.id/email/role); every row would be listed',
      },
    ]);
  });
  it("an update or delete condition reading a variable a record does not have", () => {
    const odd: Expression = { kind: "eq", left: v("record.tagsId"), right: v("user.id") };
    expect(errors(doc, grant("Note", ["update", "delete"], odd))).toEqual([
      {
        feature: "apiGrantCondition",
        location: { contentType: "Note", rule: "member" },
        severity: "error",
        message:
          'role "member" may update "Note" under a condition that reads record.tagsId, which the Strapi content API cannot read off an entry (only user.id/email/role, record.<field> and record.<relation>Id of an owning relation)',
      },
      {
        feature: "apiGrantCondition",
        location: { contentType: "Note", rule: "member" },
        severity: "error",
        message:
          'role "member" may delete "Note" under a condition that reads record.tagsId, which the Strapi content API cannot read off an entry (only user.id/email/role, record.<field> and record.<relation>Id of an owning relation)',
      },
    ]);
  });
  it("a create condition reading a relation the client writes, which is unknown before the write", () => {
    expect(errors(doc, grant("Note", ["create"], owned))).toEqual([
      {
        feature: "apiGrantCondition",
        location: { contentType: "Note", rule: "member" },
        severity: "error",
        message:
          'role "member" may create "Note" under a condition that reads record.ownerId, which the Strapi content API cannot know before the entry is written (assign the relation from user.id, or condition on fields only)',
      },
    ]);
  });
  it("a condition on a single type", () => {
    const single: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        { name: "Home", kind: "single", fields: [{ type: "boolean", name: "shared" }] },
      ],
    };
    const shared: Expression = {
      kind: "eq",
      left: v("record.shared"),
      right: { kind: "lit", value: true },
    };
    expect(errors(single, grant("Home", ["read"], shared))).toEqual([
      {
        feature: "apiGrantCondition",
        location: { contentType: "Home", rule: "member" },
        severity: "error",
        message:
          'role "member" holds single type "Home" under a condition or assign, which the Strapi target does not enforce on a single type',
      },
    ]);
  });
  it("a condition on the built-in user or the media library, which their plugins serve", () => {
    const withFile: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        { name: "File", kind: "collection", builtin: "file", fields: [] },
      ],
    };
    const self: Expression = { kind: "eq", left: v("record.id"), right: v("user.id") };
    expect(errors(withFile, grant("User", ["read"], self)).map((g) => g.message)).toEqual([
      'role "member" holds "User" under a condition, which the users-permissions plugin serves unconditioned; the Strapi target cannot enforce it',
    ]);
    expect(errors(withFile, grant("File", ["read"], self)).map((g) => g.message)).toEqual([
      'role "member" holds "File" under a condition, which the upload plugin serves unconditioned; the Strapi target cannot enforce it',
    ]);
  });
});

describe("a reach the Strapi content API cannot narrow fails the build", () => {
  const member: Role[] = [
    {
      name: "member",
      grants: [
        { contentType: "Note", actions: ["read"], condition: owned },
        { contentType: "Tag", actions: ["read"] },
      ],
    },
  ];

  // A polymorphic relation may point at any type; its populate takes no per-target filter Strapi
  // is known to honour, so a role that reads its holder while reading some type under a condition
  // cannot be kept from that type's rows through it.
  it("a polymorphic relation on a type a role reads while it reads another type under a condition", () => {
    const morph: IrDocument = {
      ...doc,
      contentTypes: doc.contentTypes.map((ct) =>
        ct.name === "Tag"
          ? {
              ...ct,
              fields: [
                { type: "string", name: "label" },
                { type: "polymorphicRelation", name: "about", many: true },
              ],
            }
          : ct,
      ),
    };
    expect(errors(morph, member)).toEqual([
      {
        feature: "apiPolymorphicReach",
        location: { contentType: "Tag", rule: "member" },
        severity: "error",
        message:
          'role "member" reads "Tag", whose polymorphic relation Tag.about can reach "Note", which it reads under a condition; the Strapi target cannot narrow a polymorphic populate or write',
      },
    ]);
  });
  // The built-in user's inverse is served by the users-permissions plugin (/api/users/me), which
  // camis does not wrap.
  it("an inverse of a conditioned type's relation that lands on the built-in user", () => {
    const inverse: IrDocument = {
      ...doc,
      contentTypes: doc.contentTypes.map((ct) =>
        ct.name === "Note"
          ? {
              ...ct,
              fields: ct.fields.map((f) =>
                f.name === "owner" && f.type === "relation" ? { ...f, inverse: "notes" } : f,
              ),
            }
          : ct,
      ),
    };
    expect(errors(inverse, member)).toEqual([
      {
        feature: "apiRelationReach",
        location: { contentType: "Note", rule: "member" },
        severity: "error",
        message:
          'role "member" reads "Note" under a condition, but User.notes reaches it from a type the users-permissions plugin serves; the Strapi target cannot narrow that populate',
      },
    ]);
  });
  it("a single type that reaches a conditioned type", () => {
    const single: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        {
          name: "Home",
          kind: "single",
          fields: [{ type: "relation", name: "pinned", relationKind: "manyToOne", target: "Tag" }],
        },
      ],
    };
    const reader: Role[] = [
      { ...member[0]!, grants: [...member[0]!.grants, { contentType: "Home", actions: ["read"] }] },
    ];
    expect(errors(single, reader)).toEqual([
      {
        feature: "apiRelationReach",
        location: { contentType: "Home", rule: "member" },
        severity: "error",
        message:
          'role "member" reads single type "Home", which reaches "Note" (read under a condition) through Home.pinned; the Strapi target does not narrow a single type\'s populate or relation writes',
      },
    ]);
  });
});
