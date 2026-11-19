import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { projectExpressPermissions } from "./project";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "string", name: "secretNotes" },
        {
          type: "relation",
          name: "author",
          relationKind: "manyToOne",
          target: "Author",
          inverse: "articles",
        },
      ],
    },
    {
      name: "Author",
      kind: "collection",
      fields: [{ type: "string", name: "name", required: true }],
    },
  ],
  components: [],
};

const roles: Role[] = [
  {
    name: "Editor",
    grants: [
      {
        contentType: "Article",
        actions: ["read", "update", "publish"],
        condition: {
          kind: "eq",
          left: { kind: "var", name: "record.title" },
          right: { kind: "lit", value: "x" },
        },
        fieldRules: [
          {
            field: "secretNotes",
            access: "read",
            when: {
              kind: "eq",
              left: { kind: "var", name: "user.id" },
              right: { kind: "var", name: "record.author" },
            },
          },
          { field: "ghost", access: "write" },
        ],
      },
    ],
  },
];

describe("projectExpressPermissions", () => {
  const p = projectExpressPermissions(doc, roles);
  it("collects sorted actions per role/contentType", () => {
    expect(p.grants.Editor!.Article).toEqual(["publish", "read", "update"]);
  });
  it("captures the record condition for each action it governs", () => {
    expect(p.conditions.Editor!.Article!.read!.kind).toBe("eq");
    expect(p.conditions.Editor!.Article!.update!.kind).toBe("eq");
  });
  it("keeps valid field rules and drops unknown-field rules with a gap", () => {
    expect(p.fieldRules.Editor!.Article!.map((r) => r.field)).toEqual(["secretNotes"]);
    expect(
      p.gaps.some((g) => g.feature === "unknownFieldRule" && g.location.field === "ghost"),
    ).toBe(true);
  });
  it("gaps the publish action (no REST analog)", () => {
    expect(p.gaps.some((g) => g.feature === "publishAction")).toBe(true);
  });
  it("gaps a condition referencing a relation field (record.author escapes the scalar set)", () => {
    expect(p.gaps.some((g) => g.feature === "conditionContext")).toBe(true);
  });
});

describe("projectExpressPermissions — ownership conditions", () => {
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
    const result = projectExpressPermissions(doc, roles);
    expect(result.gaps).toEqual([]);
  });
});

describe("plugin services", () => {
  it("are reported, as the Express target serves none", () => {
    const p = projectExpressPermissions(doc, [
      { name: "public", grants: [], services: ["locales.list"] },
    ]);
    expect(p.gaps).toContainEqual(
      expect.objectContaining({ feature: "service", location: { rule: "public" } }),
    );
  });
});

describe("projectExpressPermissions — several grants on one type", () => {
  const byCreator = {
    kind: "eq",
    left: { kind: "var", name: "record.authorId" },
    right: { kind: "var", name: "user.id" },
  } as const;
  const published = {
    kind: "eq",
    left: { kind: "var", name: "record.title" },
    right: { kind: "lit", value: "published" },
  } as const;
  const p = projectExpressPermissions(doc, [
    {
      name: "Author",
      grants: [
        { contentType: "Article", actions: ["delete", "update"], condition: byCreator },
        { contentType: "Article", actions: ["read"], condition: published },
        { contentType: "Article", actions: ["read"], condition: byCreator },
        { contentType: "Author", actions: ["read"] },
        { contentType: "Author", actions: ["read", "update"], condition: published },
      ],
    },
  ]);

  // One condition per type would let the last grant's condition govern every action: here a
  // published article could be deleted by anyone holding the read grant's condition.
  it("keeps each action's own condition", () => {
    expect(p.conditions.Author!.Article!.delete).toEqual(byCreator);
    expect(p.conditions.Author!.Article!.update).toEqual(byCreator);
  });
  it("lets either of two conditions on one action through", () => {
    expect(p.conditions.Author!.Article!.read).toEqual({
      kind: "or",
      args: [published, byCreator],
    });
  });
  it("leaves an action a grant gives outright unconditioned, whatever another grant adds", () => {
    expect(p.conditions.Author!.Author!.read).toBeUndefined();
    expect(p.conditions.Author!.Author!.update).toEqual(published);
  });
});

describe("projectExpressPermissions — assign", () => {
  const owned: IrDocument = {
    version: 1,
    contentTypes: [
      {
        name: "Note",
        kind: "collection",
        fields: [
          { type: "text", name: "text" },
          { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        ],
      },
      { name: "User", kind: "collection", builtin: "user", fields: [] },
    ],
    components: [],
  };
  const p = projectExpressPermissions(owned, [
    {
      name: "member",
      grants: [{ contentType: "Note", actions: ["create", "read"], assign: { owner: "user.id" } }],
    },
  ]);
  it("names the owning column a create fills from the signed-in user", () => {
    expect(p.assigns.member!.Note).toEqual(["owner_id"]);
  });
});
