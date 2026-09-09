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
