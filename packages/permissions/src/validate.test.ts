import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { validateBundle } from "./validate";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
};

describe("validateBundle", () => {
  it("accepts grants and field rules that reference existing targets", () => {
    const r = validateBundle({
      document: doc,
      roles: [
        {
          name: "Ed",
          grants: [
            {
              contentType: "Article",
              actions: ["read"],
              fieldRules: [{ field: "title", access: "read" }],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects a grant on an unknown content type", () => {
    const r = validateBundle({
      document: doc,
      roles: [{ name: "Ed", grants: [{ contentType: "Ghost", actions: ["read"] }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("unknown_grant_content_type");
  });
  it("rejects a field rule on an unknown field", () => {
    const r = validateBundle({
      document: doc,
      roles: [
        {
          name: "Ed",
          grants: [
            {
              contentType: "Article",
              actions: ["read"],
              fieldRules: [{ field: "ghost", access: "read" }],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("unknown_field_rule_field");
  });
});
