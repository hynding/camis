import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { projectFilamentPermissions } from "./project";

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
    expect(article.methods.map((m) => m.method)).toEqual(["viewAny", "view", "update"]);
    expect(article.methods.find((m) => m.method === "view")!.condition).toEqual(condition);
    expect(out.gaps).toEqual([]);
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
  it("gaps a divergent multi-role condition on the same action (first wins)", () => {
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
    ];
    const out = projectFilamentPermissions(doc, roles);
    expect(out.gaps.some((g) => g.feature === "conditionConflict")).toBe(true);
    // first-wins: the read-action methods carry RoleA's condition (condA), not condB.
    const view = out.policies
      .find((p) => p.contentType === "Article")!
      .methods.find((m) => m.method === "view")!;
    expect(view.condition).toEqual(condA);
  });
});
