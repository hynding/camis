import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { CREATED_BY, type Role } from "@camis/permissions";
import { projectFilamentPermissions } from "./project";
import { strapiApiBundle } from "../strapi-api/__fixtures__/strapi-api";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title" },
        { type: "string", name: "status" },
      ],
    },
  ],
  components: [],
};

const condition = {
  kind: "eq",
  left: { kind: "var", name: "record.status" },
  right: { kind: "lit", value: "published" },
} as const;

describe("projectFilamentPermissions", () => {
  it("emits sorted Spatie keys, role grants, and a policy spec carrying the condition", () => {
    const roles: Role[] = [
      {
        name: "Editor",
        grants: [{ contentType: "Article", actions: ["read", "update"], condition }],
      },
    ];
    const out = projectFilamentPermissions(doc, roles);
    expect(out.permissionKeys).toEqual(["article.read", "article.update"]);
    expect(out.roleGrants).toEqual([{ role: "Editor", keys: ["article.read", "article.update"] }]);
    const article = out.policies.find((p) => p.contentType === "Article")!;
    // Every action has a method, so the admin, which allows what a policy has no method for,
    // refuses what no role grants as the API does.
    expect(article.methods.map((m) => m.method)).toEqual([
      "create",
      "deleteAny",
      "delete",
      "viewAny",
      "view",
      "updateAny",
      "update",
    ]);
    // Every method carries the roles whose grants hold its key, so a layout without a
    // permission table can gate on role membership instead; none holds create or delete.
    expect(article.methods.map((m) => m.roles)).toEqual([
      [],
      [],
      [],
      ["Editor"],
      ["Editor"],
      ["Editor"],
      ["Editor"],
    ]);
    expect(article.methods.find((m) => m.method === "view")!.conditions).toEqual([
      { roles: ["Editor"], condition },
    ]);
    expect(out.gaps).toEqual([]);
  });
  it("gives a type no role mentions a policy that refuses everything", () => {
    const withNote: IrDocument = {
      ...doc,
      contentTypes: [...doc.contentTypes, { name: "Note", kind: "collection", fields: [] }],
    };
    const roles: Role[] = [
      { name: "Editor", grants: [{ contentType: "Article", actions: ["read"] }] },
    ];
    const note = projectFilamentPermissions(withNote, roles).policies.find(
      (p) => p.contentType === "Note",
    )!;
    expect(note.methods.map((m) => m.method)).toEqual([
      "create",
      "deleteAny",
      "delete",
      "viewAny",
      "view",
      "updateAny",
      "update",
    ]);
    expect(note.methods.every((m) => m.roles.length === 0)).toBe(true);
  });

  it("adds publish for a draft-and-publish type", () => {
    const versioned: IrDocument = {
      ...doc,
      contentTypes: [{ ...doc.contentTypes[0]!, options: { draftPublish: true } }],
    };
    const roles: Role[] = [
      { name: "Editor", grants: [{ contentType: "Article", actions: ["read"] }] },
    ];
    const article = projectFilamentPermissions(versioned, roles).policies[0]!;
    expect(article.methods.map((m) => m.method)).toContain("publish");
  });

  it("gaps a field-level rule", () => {
    const roles: Role[] = [
      {
        name: "R",
        grants: [
          {
            contentType: "Article",
            actions: ["read"],
            fieldRules: [{ field: "status", access: "read" }],
          },
        ],
      },
    ];
    expect(projectFilamentPermissions(doc, roles).gaps.some((g) => g.feature === "fieldRule")).toBe(
      true,
    );
  });
  it("gaps a predicate var outside user.* and record.<fields>", () => {
    const bad = { kind: "var", name: "request.ip" } as const;
    const roles: Role[] = [
      { name: "R", grants: [{ contentType: "Article", actions: ["read"], condition: bad }] },
    ];
    expect(
      projectFilamentPermissions(doc, roles).gaps.some((g) => g.feature === "conditionContext"),
    ).toBe(true);
  });
  it("lists every role holding a key, sorted, and none for a key no role grants", () => {
    const roles: Role[] = [
      { name: "Zeta", grants: [{ contentType: "Article", actions: ["read"] }] },
      { name: "Alpha", grants: [{ contentType: "Article", actions: ["read", "update"] }] },
    ];
    const out = projectFilamentPermissions(doc, roles);
    const byMethod = Object.fromEntries(
      out.policies.find((p) => p.contentType === "Article")!.methods.map((m) => [m.method, m]),
    );
    expect(byMethod.viewAny!.roles).toEqual(["Alpha", "Zeta"]);
    expect(byMethod.update!.roles).toEqual(["Alpha"]);
  });
  // Each role holds its grant under its own condition: one role's condition must neither narrow
  // a role holding the action outright nor stand in for another role's.
  it("keeps each role's condition to that role", () => {
    const condA = {
      kind: "eq",
      left: { kind: "var", name: "user.role" },
      right: { kind: "lit", value: "a" },
    } as const;
    const condB = {
      kind: "eq",
      left: { kind: "var", name: "user.role" },
      right: { kind: "lit", value: "b" },
    } as const;
    const roles: Role[] = [
      { name: "RoleA", grants: [{ contentType: "Article", actions: ["read"], condition: condA }] },
      { name: "RoleB", grants: [{ contentType: "Article", actions: ["read"], condition: condB }] },
      { name: "RoleC", grants: [{ contentType: "Article", actions: ["read"] }] },
      { name: "RoleD", grants: [{ contentType: "Article", actions: ["read"], condition: condA }] },
    ];
    const out = projectFilamentPermissions(doc, roles);
    expect(out.gaps.filter((g) => g.feature === "conditionConflict")).toHaveLength(1);
    const view = out.policies
      .find((p) => p.contentType === "Article")!
      .methods.find((m) => m.method === "view")!;
    expect(view.roles).toEqual(["RoleA", "RoleB", "RoleC", "RoleD"]);
    expect(view.conditions).toEqual([
      { roles: ["RoleA", "RoleD"], condition: condA },
      { roles: ["RoleB"], condition: condB },
    ]);
  });
  it("lets a role holding an action outright through any grant of it under a condition", () => {
    const roles: Role[] = [
      {
        name: "Mixed",
        grants: [
          { contentType: "Article", actions: ["read"], condition },
          { contentType: "Article", actions: ["read"] },
        ],
      },
    ];
    const view = projectFilamentPermissions(doc, roles).policies[0]!.methods.find(
      (m) => m.method === "view",
    )!;
    expect(view.conditions).toBeUndefined();
  });
  it("joins one role's conditions on an action as alternatives", () => {
    const other = { ...condition, right: { kind: "lit", value: "draft" } } as const;
    const roles: Role[] = [
      {
        name: "Two",
        grants: [
          { contentType: "Article", actions: ["read"], condition },
          { contentType: "Article", actions: ["read"], condition: other },
        ],
      },
    ];
    const view = projectFilamentPermissions(doc, roles).policies[0]!.methods.find(
      (m) => m.method === "view",
    )!;
    expect(view.conditions).toEqual([
      { roles: ["Two"], condition: { kind: "or", args: [condition, other] } },
    ]);
  });
});

describe("projectFilamentPermissions — the creator of an entry", () => {
  const isCreator = {
    kind: "eq",
    left: { kind: "var", name: CREATED_BY },
    right: { kind: "var", name: "user.id" },
  } as const;
  const roles: Role[] = [
    {
      name: "author",
      admin: true,
      grants: [
        {
          contentType: "Article",
          actions: ["create", "read", "update", "delete"],
          condition: isCreator,
        },
      ],
    },
    { name: "editor", admin: true, grants: [{ contentType: "Article", actions: ["read"] }] },
  ];

  it("lets an admin role's condition name the entry's creator where the target records one", () => {
    const out = projectFilamentPermissions(doc, roles, { creators: true });
    expect(out.gaps).toEqual([]);
    const update = out.policies[0]!.methods.find((m) => m.method === "update")!;
    expect(update.conditions).toEqual([{ roles: ["author"], condition: isCreator }]);
  });
  it("reports the creator as unknown where the target records none, so the grant denies", () => {
    const gaps = projectFilamentPermissions(doc, roles).gaps;
    expect(gaps.map((g) => g.feature)).toEqual(["conditionContext"]);
    expect(gaps[0]!.message).toContain(CREATED_BY);
  });
  // The creator is an admin account; an API user's id is a row of another table.
  it("reports the creator as unknown to a role that is not an admin role", () => {
    const api: Role[] = [{ ...roles[0]!, admin: false }];
    const gaps = projectFilamentPermissions(doc, api, { creators: true }).gaps;
    expect(gaps.map((g) => g.feature)).toEqual(["conditionContext"]);
  });
  it("scopes the admin list per admin role reading under a condition", () => {
    const out = projectFilamentPermissions(doc, roles, { creators: true });
    expect(out.adminReadScopes.get("Article")).toEqual({
      unconditional: ["editor"],
      conditions: [{ roles: ["author"], condition: isCreator }],
    });
  });
  it("leaves the admin list unscoped where no admin role reads under a condition", () => {
    const out = projectFilamentPermissions(doc, [roles[1]!], { creators: true });
    expect(out.adminReadScopes.size).toBe(0);
  });
  // An admin account never calls the content API, whose list scope is for its users.
  it("keeps an admin role's read condition out of the content API's list scope", () => {
    const out = projectFilamentPermissions(doc, roles, { creators: true });
    expect(out.readConditions.has("Article")).toBe(false);
  });
});

describe("projectFilamentPermissions — ownership conditions", () => {
  it("allows record.<relation>Id for owning relations without a conditionContext gap", () => {
    const doc = {
      version: 1 as const,
      contentTypes: [
        {
          name: "Note",
          kind: "collection" as const,
          fields: [
            { type: "text" as const, name: "text" },
            {
              type: "relation" as const,
              name: "owner",
              relationKind: "manyToOne" as const,
              target: "User",
            },
          ],
        },
        {
          name: "User",
          kind: "collection" as const,
          builtin: "user" as const,
          fields: [{ type: "string" as const, name: "username" }],
        },
      ],
      components: [],
    };
    const roles = [
      {
        name: "member",
        grants: [
          {
            contentType: "Note",
            actions: ["read" as const],
            condition: {
              kind: "eq" as const,
              left: { kind: "var" as const, name: "record.ownerId" },
              right: { kind: "var" as const, name: "user.id" },
            },
          },
        ],
      },
    ];
    const result = projectFilamentPermissions(doc, roles);
    expect(result.gaps).toEqual([]);
    expect(result.policies[0]?.methods.some((m) => m.conditions !== undefined)).toBe(true);
  });
});

describe("projectFilamentPermissions — condition scoping", () => {
  it("attaches record conditions only to record-scoped policy methods", () => {
    const doc = {
      version: 1 as const,
      contentTypes: [
        {
          name: "Note",
          kind: "collection" as const,
          fields: [
            { type: "text" as const, name: "text" },
            {
              type: "relation" as const,
              name: "owner",
              relationKind: "manyToOne" as const,
              target: "Note",
            },
          ],
        },
      ],
      components: [],
    };
    const roles = [
      {
        name: "member",
        grants: [
          {
            contentType: "Note",
            actions: ["create" as const, "read" as const, "update" as const],
            condition: {
              kind: "eq" as const,
              left: { kind: "var" as const, name: "record.ownerId" },
              right: { kind: "var" as const, name: "user.id" },
            },
          },
        ],
      },
    ];
    const { policies } = projectFilamentPermissions(doc, roles);
    const byMethod = Object.fromEntries(policies[0]!.methods.map((m) => [m.method, m]));
    expect(byMethod.create!.conditions).toBeUndefined();
    expect(byMethod.viewAny!.conditions).toBeUndefined();
    expect(byMethod.view!.conditions).toBeDefined();
    expect(byMethod.update!.conditions).toBeDefined();
  });
});

describe("projectFilamentPermissions readConditions + assigns", () => {
  const p = projectFilamentPermissions(strapiApiBundle.document, strapiApiBundle.roles);
  it("exposes the read condition per content type", () => {
    expect(p.readConditions.get("Note")?.kind).toBe("eq");
    expect(p.readConditions.get("Activity")?.kind).toBe("or");
    expect(p.readConditions.has("Tag")).toBe(false);
  });
  it("exposes assigns per content type, sorted", () => {
    expect(p.assigns.get("Note")).toEqual(["owner"]);
    expect(p.assigns.get("Activity")).toEqual(["creator"]);
    expect(p.assigns.has("Tag")).toBe(false);
  });
  // A catalog type is readable by everyone but writable only by its creator. One grant covering
  // read+write with the read condition would make every public row world-writable.
  it("keeps a catalog type's write condition narrower than its read condition", () => {
    const activity = p.policies.find((x) => x.contentType === "Activity")!;
    const byMethod = Object.fromEntries(activity.methods.map((m) => [m.method, m]));
    expect(byMethod.view!.conditions![0]!.condition.kind).toBe("or");
    expect(byMethod.update!.conditions![0]!.condition.kind).toBe("eq");
    expect(byMethod.delete!.conditions![0]!.condition.kind).toBe("eq");
  });
});
