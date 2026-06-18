import { describe, expect, it } from "vitest";
import { role } from "./model";

describe("role schema", () => {
  it("accepts a role with a field rule and a condition", () => {
    const r = role.safeParse({
      name: "Editor",
      grants: [
        {
          contentType: "Article",
          actions: ["read", "update"],
          fieldRules: [
            { field: "secret", access: "read", when: { kind: "var", name: "user.role" } },
          ],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "user.role" },
            right: { kind: "lit", value: "editor" },
          },
        },
      ],
    });
    expect(r.success).toBe(true);
  });
  it("rejects a grant with no actions", () => {
    const r = role.safeParse({ name: "X", grants: [{ contentType: "Article", actions: [] }] });
    expect(r.success).toBe(false);
  });
  it("rejects a condition that is not a valid expression", () => {
    const r = role.safeParse({
      name: "X",
      grants: [{ contentType: "Article", actions: ["read"], condition: { kind: "loop" } }],
    });
    expect(r.success).toBe(false);
  });
});
