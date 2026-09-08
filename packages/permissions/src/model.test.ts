import { describe, expect, it } from "vitest";
import { grant, parseRolesFile, role } from "./model";

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

describe("grant.assign", () => {
  it("accepts assign entries whose value is user.id", () => {
    const r = grant.safeParse({
      contentType: "Note",
      actions: ["create"],
      assign: { owner: "user.id" },
    });
    expect(r.success).toBe(true);
  });
  it("rejects assign values other than user.id", () => {
    const r = grant.safeParse({ contentType: "Note", actions: ["create"], assign: { owner: "x" } });
    expect(r.success).toBe(false);
  });
});

describe("parseRolesFile", () => {
  const roles = [{ name: "authenticated", grants: [] }];
  it("accepts the bare array form with no defaultRole", () => {
    expect(parseRolesFile(roles)).toEqual({ ok: true, value: { roles } });
  });
  it("accepts the object form with defaultRole", () => {
    expect(parseRolesFile({ defaultRole: "authenticated", roles })).toEqual({
      ok: true,
      value: { defaultRole: "authenticated", roles },
    });
  });
  // A bare `undefined` told the caller only that *something* was wrong, so the CLI could say no
  // more than "expected a Role[]" for a single mistyped action deep inside one grant.
  it("reports the object-form zod issues as path: message when both forms fail", () => {
    const r = parseRolesFile({ roles: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatch(/^roles: /);
    }
  });
  it("locates a bad value inside a grant", () => {
    const r = parseRolesFile({
      roles: [{ name: "a", grants: [{ contentType: "Note", actions: ["fly"] }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("; ")).toContain("roles.0.grants.0.actions.0");
  });
});
