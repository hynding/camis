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
  it("captures the record condition", () => {
    expect(p.conditions.Editor!.Article!.kind).toBe("eq");
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
