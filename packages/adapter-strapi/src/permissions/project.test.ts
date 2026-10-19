import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { projectApiRoles, projectPermissions } from "./project";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "secret" }] },
  ],
  components: [],
};

const editor: Role = {
  name: "Editor",
  grants: [
    {
      contentType: "Article",
      actions: ["read", "update"],
      fieldRules: [
        {
          field: "secret",
          access: "read",
          when: {
            kind: "eq",
            left: { kind: "var", name: "user.role" },
            right: { kind: "lit", value: "editor" },
          },
        },
      ],
      condition: {
        kind: "eq",
        left: { kind: "var", name: "user.role" },
        right: { kind: "lit", value: "editor" },
      },
    },
  ],
};

describe("projectPermissions", () => {
  it("emits permission entries with subject, conditions, and field-gated entry; no gaps for user.* predicates", () => {
    const out = projectPermissions(doc, [editor]);
    expect(out.gaps).toEqual([]);
    const role = out.roles.find((r) => r.name === "Editor")!;
    const read = role.permissions.find((p) => p.action.endsWith(".read") && !p.properties)!;
    expect(read.subject).toBe("api::article.article");
    expect(read.conditions).toEqual([expect.stringMatching(/^camis-cond-/)]);
    const fieldEntry = role.permissions.find((p) => p.properties?.fields?.includes("secret"))!;
    expect(fieldEntry.conditions).toEqual([expect.stringMatching(/^camis-cond-/)]);
    expect(out.conditions.length).toBe(1);
  });
  // The generated bootstrap reads `role.description` off the roles.json import, and TypeScript
  // infers that module's type from the emitted JSON: a role without the key makes the generated
  // src/index.ts fail to compile, which stops Strapi from booting at all.
  it("always emits a description key so the bootstrap compiles against roles.json", () => {
    const out = projectPermissions(doc, [editor]);
    expect(Object.keys(out.roles[0]!)).toContain("description");
    expect(out.roles[0]!.description).toBe("");
  });

  it("keeps a role's own description", () => {
    const out = projectPermissions(doc, [{ ...editor, description: "editorial staff" }]);
    expect(out.roles[0]!.description).toBe("editorial staff");
  });

  it("gaps a predicate that references vars outside user.*", () => {
    const r: Role = {
      name: "R",
      grants: [
        {
          contentType: "Article",
          actions: ["read"],
          condition: { kind: "var", name: "record.ownerId" },
        },
      ],
    };
    const out = projectPermissions(doc, [r]);
    expect(out.gaps.map((g) => g.feature)).toContain("conditionContext");
  });
  it("gaps publish on a non-draftPublish type", () => {
    const r: Role = { name: "R", grants: [{ contentType: "Article", actions: ["publish"] }] };
    const out = projectPermissions(doc, [r]);
    expect(out.gaps.map((g) => g.feature)).toContain("publishWithoutDraft");
  });
});

describe("grants on the builtin user type", () => {
  const withUser: IrDocument = {
    version: 1,
    contentTypes: [
      {
        name: "User",
        kind: "collection",
        builtin: "user",
        fields: [{ type: "string", name: "username" }],
      },
    ],
    components: [],
  };
  const manager: Role = {
    name: "authenticated",
    grants: [{ contentType: "User", actions: ["create", "read", "update", "delete"] }],
  };

  it("become the users-permissions user actions, not an api:: uid", () => {
    expect(projectApiRoles(withUser, [manager]).roles).toEqual([
      {
        type: "authenticated",
        actions: [
          "plugin::users-permissions.user.count",
          "plugin::users-permissions.user.create",
          "plugin::users-permissions.user.destroy",
          "plugin::users-permissions.user.find",
          "plugin::users-permissions.user.findOne",
          "plugin::users-permissions.user.update",
        ],
      },
    ]);
  });

  it("take the users-permissions user as their admin subject", () => {
    const out = projectPermissions(withUser, [manager]);
    expect(new Set(out.roles[0]!.permissions.map((p) => p.subject))).toEqual(
      new Set(["plugin::users-permissions.user"]),
    );
  });
});

describe("grants on the builtin file type", () => {
  const withFile: IrDocument = {
    version: 1,
    contentTypes: [{ name: "File", kind: "collection", builtin: "file", fields: [] }],
    components: [],
  };
  const uploader: Role = {
    name: "authenticated",
    grants: [{ contentType: "File", actions: ["create", "read", "update", "delete"] }],
  };

  it("become the upload plugin's content API actions", () => {
    expect(projectApiRoles(withFile, [uploader]).roles).toEqual([
      {
        type: "authenticated",
        actions: [
          "plugin::upload.content-api.destroy",
          "plugin::upload.content-api.find",
          "plugin::upload.content-api.findOne",
          "plugin::upload.content-api.upload",
        ],
      },
    ]);
  });

  it("become the media library's admin actions, which take no subject", () => {
    const out = projectPermissions(withFile, [uploader]);
    expect(out.roles[0]!.permissions).toEqual([
      { action: "plugin::upload.assets.copy-link", subject: null },
      { action: "plugin::upload.assets.create", subject: null },
      { action: "plugin::upload.assets.download", subject: null },
      { action: "plugin::upload.assets.update", subject: null },
      { action: "plugin::upload.read", subject: null },
    ]);
  });

  it("report a condition the media library cannot hold", () => {
    const out = projectPermissions(withFile, [
      {
        name: "authenticated",
        grants: [
          {
            contentType: "File",
            actions: ["read"],
            condition: { kind: "lit", value: true },
          },
        ],
      },
    ]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        feature: "fileGrantCondition",
        location: { contentType: "File", rule: "authenticated" },
      }),
    ]);
    expect(out.conditions).toEqual([]);
  });
});

describe("projectApiRoles", () => {
  it("maps grant actions to users-permissions API actions, deduped and sorted", () => {
    const out = projectApiRoles(doc, [editor]);
    expect(out.roles).toEqual([
      {
        type: "Editor",
        actions: [
          "api::article.article.find",
          "api::article.article.findOne",
          "api::article.article.update",
        ],
      },
    ]);
  });
  // Strapi validates a relation write against the *target's* `find` scope
  // (@strapi/utils throw-restricted-relations), so a role that may create a row owning a
  // relation to the built-in user cannot set that owner without it: "Invalid key owner".
  it("grants users-permissions user.find to a role that writes a relation to the builtin user", () => {
    const withUser: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Note",
          kind: "collection",
          fields: [{ type: "relation", name: "owner", relationKind: "manyToOne", target: "User" }],
        },
        {
          name: "User",
          kind: "collection",
          builtin: "user",
          fields: [{ type: "string", name: "username" }],
        },
      ],
      components: [],
    };
    const out = projectApiRoles(withUser, [
      { name: "authenticated", grants: [{ contentType: "Note", actions: ["create", "read"] }] },
    ]);
    expect(out.roles[0]!.actions).toContain("plugin::users-permissions.user.find");
    const gap = out.gaps.find((g) => g.feature === "userRelationWrite");
    expect(gap?.message).toBe(
      '"authenticated" writes a relation to the built-in user on "Note"; Strapi validates that ' +
        "against the user type's find scope, so the role also gets " +
        "plugin::users-permissions.user.find — which exposes every user's username and email at " +
        "GET /api/users",
    );
  });

  // The public role's grants apply with no Authorization header at all, so the same relation-write
  // gap is worse there: the user list becomes readable by anyone, not merely other authenticated
  // users.
  it("notes the gap is unauthenticated when the relation-writing role is literally 'public'", () => {
    const withUser: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Note",
          kind: "collection",
          fields: [{ type: "relation", name: "owner", relationKind: "manyToOne", target: "User" }],
        },
        {
          name: "User",
          kind: "collection",
          builtin: "user",
          fields: [{ type: "string", name: "username" }],
        },
      ],
      components: [],
    };
    const out = projectApiRoles(withUser, [
      { name: "public", grants: [{ contentType: "Note", actions: ["create", "read"] }] },
    ]);
    const gap = out.gaps.find((g) => g.feature === "userRelationWrite");
    expect(gap?.message).toContain(
      "which exposes every user's username and email at GET /api/users, and since this is the " +
        "public role, unauthenticated",
    );
  });

  it("does not grant user.find for a read-only grant, nor without a user relation", () => {
    const withUser: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Note",
          kind: "collection",
          fields: [{ type: "relation", name: "owner", relationKind: "manyToOne", target: "User" }],
        },
        {
          name: "User",
          kind: "collection",
          builtin: "user",
          fields: [{ type: "string", name: "username" }],
        },
      ],
      components: [],
    };
    const readOnly = projectApiRoles(withUser, [
      { name: "reader", grants: [{ contentType: "Note", actions: ["read"] }] },
    ]);
    expect(readOnly.roles[0]!.actions).not.toContain("plugin::users-permissions.user.find");
    expect(readOnly.gaps).toEqual([]);
    const noRelation = projectApiRoles(doc, [
      { name: "writer", grants: [{ contentType: "Article", actions: ["create"] }] },
    ]);
    expect(noRelation.roles[0]!.actions).not.toContain("plugin::users-permissions.user.find");
  });

  it("lists the public actions needed for registration and login, in that order", () => {
    const out = projectApiRoles(doc, [editor]);
    expect(out.public).toEqual([
      "plugin::users-permissions.auth.register",
      "plugin::users-permissions.auth.callback",
    ]);
  });
  it("gaps a conditioned grant as unconditioned at the users-permissions API", () => {
    const out = projectApiRoles(doc, [editor]);
    expect(out.gaps).toEqual([
      {
        feature: "apiGrantCondition",
        location: { contentType: "Article", rule: "Editor" },
        severity: "downgrade",
        message:
          '"Editor" grant on "Article" is unconditioned at the users-permissions API; conditions apply to the admin panel only',
      },
    ]);
  });
  it("does not gap a field rule's condition at the API level", () => {
    const r: Role = {
      name: "R",
      grants: [
        {
          contentType: "Article",
          actions: ["read"],
          fieldRules: [
            {
              field: "secret",
              access: "read",
              when: { kind: "var", name: "user.role" },
            },
          ],
        },
      ],
    };
    const out = projectApiRoles(doc, [r]);
    expect(out.gaps).toEqual([]);
  });
  it("gaps a publish grant that lacks update as a downgrade", () => {
    const r: Role = { name: "R", grants: [{ contentType: "Article", actions: ["publish"] }] };
    const out = projectApiRoles(doc, [r]);
    expect(out.gaps.map((g) => g.feature)).toContain("publishAction");
  });
  it("does not gap publishAction when update is also granted", () => {
    const r: Role = {
      name: "R",
      grants: [{ contentType: "Article", actions: ["update", "publish"] }],
    };
    const out = projectApiRoles(doc, [r]);
    expect(out.gaps.map((g) => g.feature)).not.toContain("publishAction");
  });
  it("ignores actions with no users-permissions API equivalent (publish alone)", () => {
    const r: Role = { name: "R", grants: [{ contentType: "Article", actions: ["publish"] }] };
    const out = projectApiRoles(doc, [r]);
    expect(out.roles).toEqual([{ type: "R", actions: [] }]);
  });
});
