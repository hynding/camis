import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { ownershipBundle } from "../__fixtures__/ownership";
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
      ["Tag", false],
    ]);
    expect(out.types.find((t) => t.contentType === "Tag")!.roles).toEqual({});
  });
  it("maps how each holder reaches a conditioned type: relations, inverses, components, media", () => {
    expect(out.holders).toEqual({
      "api::category.category": {
        populatable: ["notes"],
        links: { notes: { relation: "api::note.note" } },
      },
      // A file's `related` entries are any entry it is attached to: a note's attachment leads
      // back to notes.
      "api::note.note": {
        populatable: ["attachment", "category", "owner", "pinned"],
        links: {
          attachment: { media: true },
          category: { relation: "api::category.category" },
          pinned: { relation: "api::tag.tag" },
        },
      },
      "api::tag.tag": {
        populatable: ["note", "parent", "pinnedOn", "refs"],
        links: {
          note: { relation: "api::note.note" },
          parent: { relation: "api::tag.tag" },
          pinnedOn: { relation: "api::note.note" },
          refs: { component: "shared.reference" },
        },
      },
      "shared.reference": {
        populatable: ["image", "note"],
        links: { image: { media: true }, note: { relation: "api::note.note" } },
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
    const readOnly = noFiles.map((r) => ({
      ...r,
      grants: r.grants.map((g) => ({ ...g, actions: g.actions.filter((a) => a === "read") })),
    }));
    expect(projectApiEnforcement(doc, readOnly).uploads).toBeNull();
  });
  it("tables each served type's and component's writable attributes by their form", () => {
    expect(projectApiEnforcement(doc, roles).shapes).toEqual({
      "api::category.category": { label: "scalar", notes: "relation" },
      "api::note.note": {
        attachment: "media",
        category: "relation",
        owner: "relation",
        pinned: "relation",
        shared: "scalar",
        title: "scalar",
      },
      "api::tag.tag": {
        label: "scalar",
        note: "relation",
        parent: "relation",
        pinnedOn: "relation",
        refs: { component: "shared.reference", repeatable: true },
      },
      "shared.reference": { image: "media", note: "relation" },
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
    for (const actions of [["create"], ["update"]] as const) {
      const out = projectApiEnforcement(bookmark(link), writer("Bookmark", actions));
      expect(out.types.find((t) => t.contentType === "Bookmark")).toMatchObject({
        own: false,
        relations: {},
        roles: {},
      });
      expect(out.shapes["api::bookmark.bookmark"]).toEqual({ parent: "relation" });
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
