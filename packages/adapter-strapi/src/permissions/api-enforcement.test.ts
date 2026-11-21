import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { ownershipBundle } from "../__fixtures__/ownership";
import { strapiAdapter } from "../generate";
import { projectApiEnforcement } from "./api-enforcement";
import { projectUploads } from "./api-upload-enforcement";

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
      ["Category", false],
      ["Front", false],
      ["Tag", false],
    ]);
    expect(out.types.find((t) => t.contentType === "Tag")!.roles).toEqual({});
  });
  it("maps how each holder reaches a conditioned type: relations, inverses, components, media", () => {
    expect(out.holders).toEqual({
      "api::category.category": {
        populatable: ["notes"],
        unwalked: ["createdBy", "updatedBy"],
        links: { notes: { relation: "api::note.note" } },
      },
      // The single type reaches notes through its category; no role reads it.
      "api::front.front": {
        populatable: ["featured"],
        unwalked: ["createdBy", "updatedBy"],
        links: { featured: { relation: "api::category.category" } },
      },
      // A file's `related` entries are any entry it is attached to: a note's attachment leads
      // back to notes.
      "api::note.note": {
        populatable: ["attachment", "category", "owner", "pinned"],
        unwalked: ["createdBy", "updatedBy"],
        links: {
          attachment: { media: true },
          category: { relation: "api::category.category" },
          owner: { relation: "plugin::users-permissions.user" },
          pinned: { relation: "api::tag.tag" },
        },
      },
      "api::tag.tag": {
        populatable: ["note", "parent", "pinnedOn", "refs"],
        unwalked: ["createdBy", "updatedBy"],
        links: {
          note: { relation: "api::note.note" },
          parent: { relation: "api::tag.tag" },
          pinnedOn: { relation: "api::note.note" },
          refs: { component: "shared.reference" },
        },
      },
      "shared.reference": {
        populatable: ["image", "note"],
        unwalked: [],
        links: { image: { media: true }, note: { relation: "api::note.note" } },
      },
      // The user is walked beneath every relation to it: what lies under it (its role) is not
      // passed on unchecked, whatever it reaches. A content type's admin relations and the
      // user's role are Strapi's own attributes, which the graph does not walk.
      "plugin::users-permissions.user": {
        populatable: [],
        unwalked: ["createdBy", "role", "updatedBy"],
        links: {},
      },
    });
  });
  // A write through a relation both sides show changes the entry on the other side too; one
  // through a relation whose other side holds one entry at most takes it from its last holder.
  it("lists the relations whose writes change another entry: shown on a conditioned type, or taken from a holder", () => {
    const relationsOf = (name: string) => out.types.find((t) => t.contentType === name)!.relations;
    expect(relationsOf("Note")).toEqual({
      pinned: { target: "api::tag.tag", mirrored: true, toOne: false, exclusive: true },
    });
    expect(relationsOf("Category")).toEqual({
      notes: { target: "api::note.note", mirrored: true, toOne: false, exclusive: true },
    });
    expect(relationsOf("Tag")).toEqual({
      pinnedOn: { target: "api::note.note", mirrored: true, toOne: true, exclusive: false },
    });
  });
  it("makes a localized type reach through its localizations, holder or conditioned", () => {
    const localized = (name: string): IrDocument => ({
      ...doc,
      contentTypes: doc.contentTypes.map((ct) =>
        ct.name === name ? { ...ct, options: { ...ct.options, localized: true } } : ct,
      ),
    });
    const tag = projectApiEnforcement(localized("Tag"), roles).holders["api::tag.tag"]!;
    expect(tag.links.localizations).toEqual({ relation: "api::tag.tag" });
    expect(tag.populatable).toContain("localizations");
    const note = projectApiEnforcement(localized("Note"), roles).holders["api::note.note"]!;
    expect(note.links.localizations).toEqual({ relation: "api::note.note" });
  });
  // Code-point order, as the goldens need: the same bytes whatever the machine's locale.
  it("orders a holder's links by code point", () => {
    const cased: IrDocument = {
      ...doc,
      contentTypes: doc.contentTypes.map((ct) =>
        ct.name === "Tag"
          ? {
              ...ct,
              fields: [
                ...ct.fields,
                { type: "relation", name: "pina", relationKind: "manyToOne", target: "Note" },
                { type: "relation", name: "pinA", relationKind: "manyToOne", target: "Note" },
              ],
            }
          : ct,
      ),
    };
    const tag = projectApiEnforcement(cased, roles).holders["api::tag.tag"]!;
    expect(Object.keys(tag.links)).toEqual(["note", "parent", "pinA", "pina", "pinnedOn", "refs"]);
  });
  // Strapi opens an `auth: false` action to anyone; the controller must still answer it.
  it("carries a reach-only type's open actions", () => {
    const open: IrDocument = {
      ...doc,
      contentTypes: doc.contentTypes.map((ct) =>
        ct.name === "Tag" ? { ...ct, options: { publicApiActions: ["list"] } } : ct,
      ),
    };
    const tag = projectApiEnforcement(open, roles).types.find((t) => t.contentType === "Tag")!;
    expect(tag.open).toEqual(["find"]);
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
    const self: Expression = { kind: "eq", left: v("record.id"), right: v("user.id") };
    expect(errors(doc, grant("User", ["read"], self)).map((g) => g.message)).toEqual([
      'role "member" holds "User" under a condition, which the users-permissions plugin serves unconditioned; the Strapi target cannot enforce it',
    ]);
    expect(errors(doc, grant("File", ["read"], self)).map((g) => g.message)).toEqual([
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
          'role "member" reads "Tag", whose polymorphic relation Tag.about can return entries of any type, ones the role holds no grant on or reads only under a condition included: Strapi leaves a polymorphic populate unchecked when it can read none of its entries, so the Strapi target cannot narrow it or a polymorphic write',
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
  // The upload plugin serves a file's `related` entries, which may be notes, unnarrowed.
  it("a role reading the media library while a file can be attached to a type it reads under a condition", () => {
    const reader: Role[] = [
      { ...member[0]!, grants: [...member[0]!.grants, { contentType: "File", actions: ["read"] }] },
    ];
    expect(errors(doc, reader)).toEqual([
      {
        feature: "apiRelationReach",
        location: { contentType: "Note", rule: "member" },
        severity: "error",
        message:
          'role "member" reads "Note" under a condition, but File.related reaches it from a type the upload plugin serves; the Strapi target cannot narrow that populate',
      },
    ]);
  });
  // Writing User.notes moves notes between users, which the plugin's own controller allows.
  it("a role that writes a built-in type whose relation another type's conditioned entries show", () => {
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
    const writer: Role[] = [
      {
        name: "member",
        grants: [
          { contentType: "Note", actions: ["update"], condition: owned },
          { contentType: "User", actions: ["update"] },
        ],
      },
    ];
    expect(errors(inverse, writer).filter((g) => g.feature !== "apiUserWrite")).toEqual([
      {
        feature: "apiRelationReach",
        location: { contentType: "User", rule: "member" },
        severity: "error",
        message:
          'role "member" writes "User", whose relation User.notes changes entries of "Note", which it does not update outright; the users-permissions plugin serves that write unchecked',
      },
    ]);
  });
  it("a role that writes a single type whose relation another type's conditioned entries show", () => {
    const single: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        {
          name: "Home",
          kind: "single",
          fields: [
            {
              type: "relation",
              name: "featured",
              relationKind: "manyToOne",
              target: "Note",
              inverse: "featuredOn",
            },
          ],
        },
      ],
    };
    const writer: Role[] = [
      {
        name: "member",
        grants: [
          { contentType: "Note", actions: ["update"], condition: owned },
          { contentType: "Home", actions: ["update"] },
        ],
      },
    ];
    expect(errors(single, writer)).toEqual([
      {
        feature: "apiRelationReach",
        location: { contentType: "Home", rule: "member" },
        severity: "error",
        message:
          'role "member" writes single type "Home", whose relation Home.featured changes entries of "Note", which it does not update outright; Strapi\'s own single-type controller serves that write unchecked',
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
  // A write's response is populated like a read (`?populate=` on PUT or POST), and on a single
  // type or through a polymorphic relation the link it makes is not checked either: writing the
  // holder reaches what reading it would.
  it("a role that writes, without reading, a single type or a polymorphic holder that reaches a conditioned type", () => {
    const spot: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        {
          name: "Spot",
          kind: "single",
          fields: [
            { type: "relation", name: "spotlight", relationKind: "manyToOne", target: "Note" },
          ],
        },
        {
          name: "Board",
          kind: "collection",
          fields: [{ type: "polymorphicRelation", name: "subjects", many: true }],
        },
      ],
    };
    const writer: Role[] = [
      {
        ...member[0]!,
        grants: [
          ...member[0]!.grants,
          { contentType: "Spot", actions: ["update"] },
          { contentType: "Board", actions: ["create", "update"] },
        ],
      },
    ];
    expect(errors(spot, writer)).toEqual([
      {
        feature: "apiRelationReach",
        location: { contentType: "Spot", rule: "member" },
        severity: "error",
        message:
          'role "member" writes single type "Spot", which reaches "Note" (read under a condition) through Spot.spotlight; the Strapi target does not narrow a single type\'s populate or relation writes',
      },
      {
        feature: "apiPolymorphicReach",
        location: { contentType: "Board", rule: "member" },
        severity: "error",
        message:
          'role "member" writes "Board", whose polymorphic relation Board.subjects can return entries of any type, ones the role holds no grant on or reads only under a condition included: Strapi leaves a polymorphic populate unchecked when it can read none of its entries, so the Strapi target cannot narrow it or a polymorphic write',
      },
    ]);
    // An open create or update route writes as the public role.
    const opened: IrDocument = {
      ...spot,
      contentTypes: spot.contentTypes.map((ct) =>
        ct.name === "Spot" || ct.name === "Board"
          ? { ...ct, options: { publicApiActions: ["update" as const] } }
          : ct,
      ),
    };
    const guest: Role[] = [
      { name: "public", grants: [{ contentType: "Note", actions: ["read"], condition: owned }] },
    ];
    expect(errors(opened, guest).map((g) => [g.feature, g.location])).toEqual([
      ["apiRelationReach", { contentType: "Spot", rule: "public" }],
      ["apiPolymorphicReach", { contentType: "Board", rule: "public" }],
    ]);
  });
  // On an `auth: false` route Strapi sanitises with no credentials: it strips an ordinary relation
  // from populate, but not a polymorphic one, which returns entries of any type (seen on 5.48:
  // a note the public may not read, and an entry of a type it holds no grant on). So any open
  // action on a type with one, at any depth, fails the build, whatever roles the IR names.
  it("any open action on a type with a polymorphic relation, its own or a component's", () => {
    const poly: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        {
          name: "Board",
          kind: "collection",
          fields: [{ type: "polymorphicRelation", name: "subjects", many: true }],
        },
        {
          name: "Box",
          kind: "collection",
          fields: [
            { type: "component", name: "frame", component: "Holder", repeatable: false },
            { type: "dynamicZone", name: "body", components: ["Holder"] },
          ],
        },
      ],
      components: [
        ...doc.components,
        // The IR's validator keeps a polymorphic relation out of components; the check does not
        // rest on that.
        {
          name: "Pointer",
          fields: [{ type: "polymorphicRelation", name: "target", many: false }],
        } as unknown as IrDocument["components"][number],
        {
          name: "Holder",
          fields: [{ type: "component", name: "inner", component: "Pointer", repeatable: true }],
        },
      ],
    };
    const opening = (actions: ("list" | "read" | "create" | "update")[]): IrDocument => ({
      ...poly,
      contentTypes: poly.contentTypes.map((ct) =>
        ct.name === "Board" || ct.name === "Box"
          ? { ...ct, options: { publicApiActions: actions } }
          : ct,
      ),
    });
    const openGaps = (d: IrDocument, rs: Role[]) =>
      errors(d, rs).filter((g) => g.message.includes("auth: false"));
    const noPublic = roles.filter((r) => r.name !== "public");
    for (const actions of [["list"], ["read"], ["create"], ["update"]] as const)
      for (const rs of [roles, noPublic, []])
        expect(
          openGaps(opening([...actions]), rs).map((g) => [g.feature, g.location]),
          `${actions[0]} with ${rs.length} roles`,
        ).toEqual([
          ["apiPolymorphicReach", { contentType: "Board", rule: "public" }],
          ["apiPolymorphicReach", { contentType: "Box", rule: "public" }],
        ]);
    expect(openGaps(opening(["list", "read"]), [])).toEqual([
      {
        feature: "apiPolymorphicReach",
        location: { contentType: "Board", rule: "public" },
        severity: "error",
        message:
          '"Board" opens list, read to anyone (an auth: false route), and its polymorphic relation Board.subjects can return entries of any type: Strapi does not narrow a polymorphic populate there, whatever the public role holds',
      },
      {
        feature: "apiPolymorphicReach",
        location: { contentType: "Box", rule: "public" },
        severity: "error",
        message:
          '"Box" opens list, read to anyone (an auth: false route), and its polymorphic relation Pointer.target can return entries of any type: Strapi does not narrow a polymorphic populate there, whatever the public role holds',
      },
    ]);
    expect(openGaps(opening(["delete" as "list"]), [])).toEqual([]);
    expect(openGaps(poly, [])).toEqual([]);
  });
  // Strapi's sanitizer keeps a polymorphic list untouched when it can read none of its entries
  // (seen on 5.48), so a role with no condition anywhere still gets entries of types it holds no
  // grant on: every non-admin reader or writer of a polymorphic relation or inverse fails the build.
  it("a polymorphic relation or inverse, at any depth, on a type any non-admin role reads or writes", () => {
    const poly: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        {
          name: "Board",
          kind: "collection",
          fields: [{ type: "polymorphicRelation", name: "subjects", many: true }],
        },
        {
          name: "Wall",
          kind: "collection",
          fields: [
            {
              type: "polymorphicInverse",
              name: "boards",
              target: "Board",
              via: "subjects",
              many: true,
            },
          ],
        },
        {
          name: "Box",
          kind: "collection",
          fields: [{ type: "component", name: "frame", component: "Holder", repeatable: false }],
        },
      ],
      components: [
        ...doc.components,
        {
          name: "Pointer",
          fields: [{ type: "polymorphicRelation", name: "target", many: false }],
        } as unknown as IrDocument["components"][number],
        {
          name: "Holder",
          fields: [{ type: "component", name: "inner", component: "Pointer", repeatable: true }],
        },
      ],
    };
    const plain: Role[] = [
      {
        name: "viewer",
        grants: [
          { contentType: "Board", actions: ["read"] },
          { contentType: "Wall", actions: ["read"] },
        ],
      },
      { name: "editor", grants: [{ contentType: "Box", actions: ["create"] }] },
      { name: "tagger", grants: [{ contentType: "Tag", actions: ["read"] }] },
      {
        name: "boss",
        admin: true,
        grants: [{ contentType: "Board", actions: ["read", "create", "update"] }],
      },
    ];
    expect(errors(poly, plain)).toEqual([
      {
        feature: "apiPolymorphicReach",
        location: { contentType: "Board", rule: "viewer" },
        severity: "error",
        message:
          'role "viewer" reads "Board", whose polymorphic relation Board.subjects can return entries of any type, ones the role holds no grant on or reads only under a condition included: Strapi leaves a polymorphic populate unchecked when it can read none of its entries, so the Strapi target cannot narrow it or a polymorphic write',
      },
      {
        feature: "apiPolymorphicReach",
        location: { contentType: "Wall", rule: "viewer" },
        severity: "error",
        message:
          'role "viewer" reads "Wall", whose polymorphic relation Wall.boards can return entries of any type, ones the role holds no grant on or reads only under a condition included: Strapi leaves a polymorphic populate unchecked when it can read none of its entries, so the Strapi target cannot narrow it or a polymorphic write',
      },
      {
        feature: "apiPolymorphicReach",
        location: { contentType: "Box", rule: "editor" },
        severity: "error",
        message:
          'role "editor" writes "Box", whose polymorphic relation Pointer.target can return entries of any type, ones the role holds no grant on or reads only under a condition included: Strapi leaves a polymorphic populate unchecked when it can read none of its entries, so the Strapi target cannot narrow it or a polymorphic write',
      },
    ]);
    expect(
      errors(
        poly,
        plain.filter((r) => r.name === "tagger" || r.admin === true),
      ),
    ).toEqual([]);
  });
  // A file's `related` entries are polymorphic too: every type with a media field, at any depth,
  // is served so a populate of them is refused, whether or not a conditioned type holds media.
  it("serves every type with a media field, so a populate of a file's related entries is refused", () => {
    const gallery: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes.map((ct) =>
          ct.name === "Note" ? { ...ct, fields: ct.fields.filter((f) => f.type !== "media") } : ct,
        ),
        {
          name: "Gallery",
          kind: "collection",
          options: { publicApiActions: ["list", "read"] },
          fields: [{ type: "media", name: "cover", multiple: true }],
        },
        {
          name: "Home",
          kind: "single",
          options: { publicApiActions: ["read"] },
          fields: [{ type: "media", name: "logo" }],
        },
      ],
      components: doc.components.map((c) => ({
        ...c,
        fields: c.fields.filter((f) => f.type !== "media"),
      })),
    };
    const out = projectApiEnforcement(
      gallery,
      roles.filter((r) => r.name !== "member"),
    );
    expect(out.holders["api::gallery.gallery"]).toEqual({
      populatable: ["cover"],
      unwalked: ["createdBy", "updatedBy"],
      links: { cover: { media: true } },
    });
    expect(out.holders["api::home.home"]).toEqual({
      populatable: ["logo"],
      unwalked: ["createdBy", "updatedBy"],
      links: { logo: { media: true } },
    });
    expect(out.types.map((t) => t.contentType)).toEqual(
      expect.arrayContaining(["Gallery", "Home"]),
    );
    expect(out.singles).toContain("api::home.home");
    expect(out.shapes["api::gallery.gallery"]).toEqual({ cover: "media" });
    expect(out.shapes["api::home.home"]).toEqual({ logo: "toOneMedia" });
  });
  it("tables a polymorphic relation to one entry and a single media field as to-one", () => {
    const one: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        {
          name: "Pin",
          kind: "collection",
          fields: [
            { type: "polymorphicRelation", name: "target", many: false },
            { type: "polymorphicRelation", name: "targets", many: true },
            { type: "media", name: "photo", multiple: false },
            { type: "media", name: "photos", multiple: true },
          ],
        },
      ],
    };
    const writes: Role[] = [
      { name: "editor", grants: [{ contentType: "Pin", actions: ["create"] }] },
    ];
    expect(projectApiEnforcement(one, writes).shapes["api::pin.pin"]).toEqual({
      photo: "toOneMedia",
      photos: "media",
      target: "toOnePolymorphic",
      targets: "polymorphic",
    });
  });
});

// The plugins serve the built-in user and media library with no check of camis's: a write there
// must not reach what the rules guard.
describe("writes the users-permissions and upload plugins serve unchecked fail the build", () => {
  const writer = (contentType: string, actions: Role["grants"][number]["actions"]): Role[] => [
    ...roles.filter((r) => r.name !== "member"),
    {
      ...roles.find((r) => r.name === "member")!,
      grants: [...roles.find((r) => r.name === "member")!.grants, { contentType, actions }],
    },
  ];
  const featured = (d: IrDocument, rs: Role[], feature: string) =>
    errors(d, rs).filter(
      (g) =>
        g.feature === feature &&
        (feature !== "apiRelationReach" || g.message.includes("upload API")),
    );

  // The generated upload extension decides each upload API write on the entries it changes: an
  // attach needs update on the entry, a replace or delete update on every entry the file is on.
  it("no longer fails the build for a role that writes the media library: the upload API is enforced", () => {
    for (const actions of [["create"], ["update"], ["delete"]] as const)
      expect(featured(doc, writer("File", [...actions]), "apiRelationReach")).toEqual([]);
  });
  // Strapi's own single type controller links any stored file id to the entry, unchecked.
  // Strapi's own single type controller links any stored file id, whoever writes files.
  it("fails it for a single type with a media field that a restricted role or the public writes", () => {
    const home = (open?: ("create" | "update")[]): IrDocument => ({
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        {
          name: "Home",
          kind: "single",
          fields: [{ type: "media", name: "banner" }],
          ...(open === undefined ? {} : { options: { publicApiActions: open } }),
        },
      ],
    });
    const message = (who: string) =>
      `${who} may update single type "Home", whose media field Home.banner Strapi's own single type controller links to any stored file id: the rule camis holds a media link to (a file the caller uploaded through the upload API, or one on an entry it may update) does not hold there`;
    expect(featured(home(), writer("Home", ["update"]), "apiRelationReach")).toEqual([
      {
        feature: "apiRelationReach",
        location: { contentType: "Home", rule: "member" },
        severity: "error",
        message: message('role "member"'),
      },
    ]);
    expect(featured(home(), writer("Home", ["read"]), "apiRelationReach")).toEqual([]);
    const noFiles = writer("Home", ["update"]).map((r) => ({
      ...r,
      grants: r.grants.filter((g) => g.contentType !== "File"),
    }));
    expect(featured(home(), noFiles, "apiRelationReach").map((g) => g.location)).toEqual([
      { contentType: "Home", rule: "member" },
    ]);
    expect(featured(home(["update"]), roles, "apiRelationReach")).toEqual([
      {
        feature: "apiRelationReach",
        location: { contentType: "Home", rule: "public" },
        severity: "error",
        message: message("anyone (an auth: false route)"),
      },
    ]);
  });
  it("tables what the media checks need: media fields at any depth, outright readers and updaters", () => {
    expect(projectApiEnforcement(doc, roles).uploads).toEqual({
      admins: ["manager"],
      uploaderRecorded: true,
      holders: {
        "api::note.note": { fields: ["attachment"], nested: {} },
        "api::tag.tag": { fields: [], nested: { refs: { component: "shared.reference" } } },
        "shared.reference": { fields: ["image"], nested: {} },
      },
      grants: {
        "api::note.note": { read: ["reviewer"], update: [] },
        "api::tag.tag": { read: ["contributor", "drafter", "member", "public"], update: [] },
      },
    });
  });
  // Strapi needs no upload permission to link a stored file through a media field: a role that
  // writes a type with one links any file id unless the media checks run, file grants or not.
  it("tables the media checks whenever a restricted role writes a type with a media field", () => {
    const noFiles = roles.map((r) => ({
      ...r,
      grants: r.grants.filter((g) => g.contentType !== "File"),
    }));
    const out = projectApiEnforcement(doc, noFiles);
    expect(out.uploads).toMatchObject({ uploaderRecorded: false });
    expect(out.uploads?.holders).toEqual(projectApiEnforcement(doc, roles).uploads?.holders);
    // A custom API token may hold the upload API's scopes whatever the roles: wherever the rules
    // restrict anyone the upload checks are tabled; only where they restrict no one are they not.
    const readOnly = noFiles.map((r) => ({
      ...r,
      grants: r.grants.map((g) => ({ ...g, actions: g.actions.filter((a) => a === "read") })),
    }));
    expect(projectApiEnforcement(doc, readOnly).uploads).toMatchObject({
      uploaderRecorded: false,
    });
    expect(
      projectApiEnforcement(
        doc,
        roles.filter((r) => r.admin === true),
      ).uploads,
    ).toBeNull();
  });
  // The upload plugin returns a file's related entries, of any type, to whoever reads the media
  // library: its find and findOne are wrapped for every restricted reader, uploaders recorded or not.
  it("tables the upload checks, and emits the extension, when a restricted role reads the media library", () => {
    const readOnly = roles.map((r) => ({
      ...r,
      grants: r.grants
        .filter((g) => g.contentType !== "File")
        .map((g) => ({ ...g, actions: g.actions.filter((a) => a === "read") })),
    }));
    const reader = readOnly.map((r) =>
      r.name === "reviewer"
        ? { ...r, grants: [...r.grants, { contentType: "File", actions: ["read" as const] }] }
        : r,
    );
    expect(projectApiEnforcement(doc, reader).uploads).toMatchObject({ uploaderRecorded: false });
    const extension = strapiAdapter
      .generate({ document: doc, roles: reader }, { projectName: "notes" })
      .files.find((f) => f.path === "src/extensions/upload/strapi-server.ts")?.content;
    expect(extension).toContain("enforcedUpload");
    expect(extension).not.toContain("camisUploader");
    const boss: Role[] = [
      { name: "boss", admin: true, grants: [{ contentType: "File", actions: ["read"] }] },
    ];
    expect(projectApiEnforcement(doc, boss).uploads).toBeNull();
  });
  it("tables each served type's and component's writable attributes by their form", () => {
    expect(projectApiEnforcement(doc, roles).shapes).toEqual({
      "api::category.category": { label: "scalar", notes: "relation" },
      "api::front.front": { featured: "toOneRelation", headline: "scalar" },
      "api::note.note": {
        attachment: "toOneMedia",
        category: "toOneRelation",
        owner: "toOneRelation",
        pinned: "relation",
        shared: "scalar",
        title: "scalar",
      },
      "api::tag.tag": {
        label: "scalar",
        note: "toOneRelation",
        parent: "toOneRelation",
        pinnedOn: "toOneRelation",
        refs: { component: "shared.reference", repeatable: true },
      },
      "shared.reference": { image: "toOneMedia", note: "toOneRelation" },
    });
  });
  // Its media field links any stored file id unless the generated controller checks it.
  it("serves each collection type with a media field that a restricted role writes", () => {
    const album: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        { name: "Album", kind: "collection", fields: [{ type: "media", name: "cover" }] },
      ],
    };
    const served = projectApiEnforcement(album, writer("Album", ["create"])).types;
    expect(served.map((t) => [t.contentType, t.own])).toContainEqual(["Album", false]);
    expect([...projectUploads(album, writer("Album", ["create"])).served]).toEqual([
      "Note",
      "Tag",
      "Album",
    ]);
    // Reading it alone writes no link (its media reach may still have it served).
    expect([...projectUploads(album, writer("Album", ["read"])).served]).toEqual(["Note", "Tag"]);
  });
  // Strapi's database layer spreads a relation item's __pivot into the join row whatever type it
  // is written through, so a restricted write's body is checked on every type with a link.
  it("serves each collection type with a relation that a restricted role or an open route writes", () => {
    const bookmark = (fields: IrDocument["contentTypes"][number]["fields"], open = false) => ({
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        {
          name: "Bookmark",
          kind: "collection" as const,
          fields,
          ...(open ? { options: { publicApiActions: ["update" as const] } } : {}),
        },
      ],
    });
    const link = [
      {
        type: "relation" as const,
        name: "parent",
        relationKind: "manyToOne" as const,
        target: "Bookmark",
      },
    ];
    const servedOf = (d: IrDocument, rs: Role[]) =>
      projectApiEnforcement(d, rs).types.find((t) => t.contentType === "Bookmark");
    for (const actions of [["create"], ["update"]] as Role["grants"][number]["actions"][]) {
      const out = projectApiEnforcement(bookmark(link), writer("Bookmark", actions));
      expect(out.types.find((t) => t.contentType === "Bookmark")).toMatchObject({
        own: false,
        relations: {},
        roles: {},
      });
      expect(out.shapes["api::bookmark.bookmark"]).toEqual({ parent: "toOneRelation" });
    }
    expect(servedOf(bookmark(link, true), roles)).toBeDefined();
    // Read alone, or no link to write, or an admin role only: Strapi's own controller serves it.
    expect(servedOf(bookmark(link), writer("Bookmark", ["read", "delete"]))).toBeUndefined();
    expect(
      servedOf(bookmark([{ type: "string", name: "label" }]), writer("Bookmark", ["create"])),
    ).toBeUndefined();
    const admin = roles.map((r) =>
      r.name === "manager"
        ? { ...r, grants: [...r.grants, { contentType: "Bookmark", actions: ["create" as const] }] }
        : r,
    );
    expect(servedOf(bookmark(link), admin)).toBeUndefined();
  });

  // Strapi's single type controller passes a body to the same database layer: a relation item's
  // __pivot would reach the join row, so the single type gets the body check over that controller.
  it("serves a single type with a relation that a restricted role or an open route writes, for its body", () => {
    const out = projectApiEnforcement(doc, roles);
    expect(out.singles).toEqual(["api::front.front"]);
    expect(out.types.find((t) => t.contentType === "Front")).toMatchObject({
      uid: "api::front.front",
      own: false,
      roles: {},
      relations: {},
    });
    expect(out.shapes["api::front.front"]).toEqual({
      featured: "toOneRelation",
      headline: "scalar",
    });
    expect(out.gaps.filter((g) => g.location.contentType === "Front")).toEqual([]);
    const noWriter = roles.map((r) =>
      r.name === "reviewer"
        ? { ...r, grants: r.grants.filter((g) => g.contentType !== "Front") }
        : r,
    );
    // Front also reaches notes, so it is served for its query whoever writes it.
    expect(projectApiEnforcement(doc, noWriter).singles).toEqual(["api::front.front"]);
    const opened: IrDocument = {
      ...doc,
      contentTypes: [
        ...doc.contentTypes,
        { name: "Banner", kind: "single", fields: [{ type: "string", name: "text" }] },
        {
          name: "Ticker",
          kind: "single",
          options: { publicApiActions: ["update"] },
          fields: [{ type: "relation", name: "pick", relationKind: "manyToOne", target: "User" }],
        },
      ],
    };
    // A single type with no link is Strapi's; one an open route writes is served for its body.
    expect(projectApiEnforcement(opened, noWriter).singles).toEqual([
      "api::front.front",
      "api::ticker.ticker",
    ]);
  });

  // users-permissions' user update and create take any role and password from the body.
  it("a non-admin role that creates or updates the built-in user", () => {
    for (const action of ["create", "update"] as const) {
      expect(featured(doc, writer("User", [action]), "apiUserWrite")).toEqual([
        {
          feature: "apiUserWrite",
          location: { contentType: "User", rule: "member" },
          severity: "error",
          message: `role "member" may ${action} the built-in user, and Strapi's users-permissions ${action === "update" ? "update (PUT /api/users/:id)" : "create (POST /api/users)"} sets the role and password of any user from the body: the caller could take any other role, and every grant the rules guard`,
        },
      ]);
    }
    expect(featured(doc, writer("User", ["read", "delete"]), "apiUserWrite")).toEqual([]);
    const everything: Role[] = [
      {
        name: "member",
        grants: doc.contentTypes.map((ct) => ({
          contentType: ct.name,
          actions: ["create", "read", "update", "delete"] as const,
        })) as Role["grants"],
      },
    ];
    // Holding every action on every type is no exemption: another role may hold an endpoint or
    // a plugin service this one lacks, and the user API would let it take that role.
    expect(featured(doc, everything, "apiUserWrite").map((g) => g.message.split(",")[0])).toEqual([
      'role "member" may create the built-in user',
      'role "member" may update the built-in user',
    ]);
  });
});

// Strapi keeps a polymorphic list whole when the caller may read none of its entries: wherever the
// rules restrict anyone, every type with a polymorphic relation or inverse, and every type leading
// to one, is served so a populate of it is refused at runtime, not left to Strapi stripping the
// ordinary relation on the way (a role reading the polymorphic type itself fails the build).
describe("a polymorphic relation no role reaches", () => {
  const shelf: IrDocument = {
    ...doc,
    contentTypes: [
      ...doc.contentTypes,
      {
        name: "Board",
        kind: "collection",
        fields: [{ type: "polymorphicRelation", name: "subjects", many: true }],
      },
      {
        name: "Shelf",
        kind: "collection",
        fields: [{ type: "relation", name: "board", relationKind: "manyToOne", target: "Board" }],
      },
    ],
  };
  it("is served, with every type leading to it, its populate a polymorphic link", () => {
    const out = projectApiEnforcement(shelf, roles);
    expect(out.gaps.filter((g) => g.severity === "error")).toEqual([]);
    expect(out.holders["api::board.board"]).toEqual({
      populatable: ["subjects"],
      unwalked: ["createdBy", "updatedBy"],
      links: { subjects: { polymorphic: true } },
    });
    expect(out.holders["api::shelf.shelf"]).toEqual({
      populatable: ["board"],
      unwalked: ["createdBy", "updatedBy"],
      links: { board: { relation: "api::board.board" } },
    });
    expect(out.types.map((t) => t.contentType)).toEqual(expect.arrayContaining(["Board", "Shelf"]));
  });
  it("is not served where the rules restrict no one", () => {
    expect(
      projectApiEnforcement(
        shelf,
        roles.filter((r) => r.admin === true),
      ).types,
    ).toEqual([]);
  });
});

// The built-in user is served by users-permissions, but a relation to it leads on through its
// inverses (a board's author to the author's boards): the user is a node of the reach graph, so a
// populate through it is walked, and a type reaching a polymorphic relation only through it is
// served.
describe("the built-in user in the reach graph", () => {
  const via: IrDocument = {
    ...doc,
    contentTypes: [
      ...doc.contentTypes,
      {
        name: "Board",
        kind: "collection",
        fields: [
          { type: "polymorphicRelation", name: "subjects", many: true },
          {
            type: "relation",
            name: "author",
            relationKind: "manyToOne",
            target: "User",
            inverse: "boards",
          },
        ],
      },
      {
        name: "Album",
        kind: "collection",
        fields: [{ type: "relation", name: "curator", relationKind: "manyToOne", target: "User" }],
      },
    ],
  };
  it("links a relation to the user and the user's inverses, and serves the type reaching through it", () => {
    const out = projectApiEnforcement(via, roles);
    expect(out.holders["api::album.album"]).toEqual({
      populatable: ["curator"],
      unwalked: ["createdBy", "updatedBy"],
      links: { curator: { relation: "plugin::users-permissions.user" } },
    });
    expect(out.holders["plugin::users-permissions.user"]?.links).toEqual({
      boards: { relation: "api::board.board" },
    });
    expect(out.types.map((t) => t.contentType)).toContain("Album");
    expect(out.types.map((t) => t.contentType)).not.toContain("User");
  });
});

// The IR may name more than one built-in user (or file) type; each is the same Strapi type, so
// their inverses share one node, and a grant on any of them is a grant on that type.
describe("two built-in user types and two built-in file types", () => {
  const twice: IrDocument = {
    ...doc,
    contentTypes: [
      ...doc.contentTypes,
      { name: "Member", kind: "collection", builtin: "user", fields: [] },
      { name: "Upload", kind: "collection", builtin: "file", fields: [] },
      {
        name: "Album",
        kind: "collection",
        fields: [
          { type: "media", name: "art" },
          {
            type: "relation",
            name: "curator",
            relationKind: "manyToOne",
            target: "Member",
            inverse: "albums",
          },
        ],
      },
      {
        name: "Post",
        kind: "collection",
        fields: [
          {
            type: "relation",
            name: "writer",
            relationKind: "manyToOne",
            target: "User",
            inverse: "posts",
          },
        ],
      },
    ],
  };
  it("merges every built-in user's inverses into one holder", () => {
    const out = projectApiEnforcement(twice, roles);
    expect(out.holders["plugin::users-permissions.user"]?.links).toMatchObject({
      albums: { relation: "api::album.album" },
    });
    expect(out.holders["plugin::users-permissions.user"]?.populatable).toEqual(
      expect.arrayContaining(["albums", "posts"]),
    );
    expect(out.holders["api::post.post"]?.links).toEqual({
      writer: { relation: "plugin::users-permissions.user" },
    });
  });
  it("decides a grant on any of them as one on the built-in type", () => {
    const writer: Role[] = [
      { name: "member", grants: [{ contentType: "Member", actions: ["update"] }] },
    ];
    expect(errors(twice, writer).map((g) => g.feature)).toContain("apiUserWrite");
    const reader: Role[] = [
      {
        name: "member",
        grants: [
          { contentType: "Note", actions: ["read"], condition: owned },
          { contentType: "Upload", actions: ["read"] },
        ],
      },
    ];
    expect(errors(twice, reader).map((g) => [g.feature, g.location.contentType])).toContainEqual([
      "apiRelationReach",
      "Note",
    ]);
    const uploader: Role[] = [
      { name: "member", grants: [{ contentType: "Upload", actions: ["create"] }] },
    ];
    expect(projectApiEnforcement(twice, uploader).uploads).toMatchObject({
      uploaderRecorded: true,
    });
  });
});

// A role with no condition needs no condition module, but the bootstrap imports one.
describe("roles without any condition", () => {
  it("still emit the condition module the bootstrap imports, and every import it names", () => {
    const plain = roles.map((r) => ({
      ...r,
      grants: r.grants.map((g) => ({ contentType: g.contentType, actions: g.actions })),
    }));
    const result = strapiAdapter.generate(
      { document: doc, roles: plain },
      { projectName: "plain" },
    );
    const paths = new Set(result.files.map((f) => f.path));
    const index = result.files.find((f) => f.path === "src/index.ts")!.content;
    const imports = [...index.matchAll(/from "\.\/([^"]+)"/g)].map((m) => `src/${m[1]!}`);
    expect(imports.length).toBeGreaterThan(0);
    for (const path of imports)
      expect(
        [path, `${path}.ts`].some((p) => paths.has(p)),
        path,
      ).toBe(true);
  });
});

// An `auth: false` route is open whatever roles the IR names, none included: with no role at all,
// the open routes are still enforced, and only an IR with neither emits no enforcement.
describe("an IR with no roles", () => {
  const generate = (contentTypes: IrDocument["contentTypes"]) =>
    strapiAdapter.generate(
      { document: { ...doc, contentTypes: [...doc.contentTypes, ...contentTypes] }, roles: [] },
      { projectName: "open" },
    );
  const file = (result: ReturnType<typeof generate>, path: string) =>
    result.files.find((f) => f.path === path)?.content;

  it("fails the build for an open action on a type with a polymorphic relation", () => {
    const result = generate([
      {
        name: "Board",
        kind: "collection",
        options: { publicApiActions: ["list", "read"] },
        fields: [{ type: "polymorphicRelation", name: "subjects", many: true }],
      },
    ]);
    expect(
      result.gaps.gaps.filter((g) => g.severity === "error").map((g) => [g.feature, g.location]),
    ).toEqual([["apiPolymorphicReach", { contentType: "Board", rule: "public" }]]);
  });
  it("serves an open type with a media field, so a populate of a file's related entries is refused", () => {
    const result = generate([
      {
        name: "Gallery",
        kind: "collection",
        options: { publicApiActions: ["list", "read"] },
        fields: [{ type: "media", name: "cover", multiple: true }],
      },
    ]);
    expect(file(result, "src/api/gallery/controllers/gallery.ts")).toContain("enforcedController");
    expect(file(result, "src/permissions/api-conditions.ts")).toContain('"api::gallery.gallery"');
    expect(file(result, "src/permissions/roles.json")).toBeUndefined();
    expect(file(result, "src/index.ts")).not.toContain("roles.json");
  });
  it("emits no enforcement when no route is open either", () => {
    const result = generate([
      {
        name: "Gallery",
        kind: "collection",
        fields: [{ type: "media", name: "cover", multiple: true }],
      },
    ]);
    expect(result.files.filter((f) => f.path.startsWith("src/permissions/"))).toEqual([]);
    expect(file(result, "src/api/gallery/controllers/gallery.ts")).not.toContain(
      "enforcedController",
    );
  });
});
