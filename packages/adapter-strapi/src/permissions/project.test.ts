import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { projectPermissions } from "./project";

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
