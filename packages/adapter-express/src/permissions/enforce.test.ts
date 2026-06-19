import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { emitEnforce } from "./enforce";
import type { ExpressPermissions } from "./project";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "secretNotes" }] },
  ],
  components: [],
};

const perms: ExpressPermissions = {
  roles: ["Editor"],
  grants: { Editor: { Article: ["read", "update"] } },
  conditions: { Editor: { Article: { kind: "lit", value: true } } },
  fieldRules: { Editor: { Article: [{ field: "secretNotes", access: "read" }] } },
  gaps: [],
};

describe("emitEnforce", () => {
  const file = emitEnforce(perms, doc);
  it("emits fail-closed allow + the guard helpers", () => {
    expect(file).toContain(
      "const allow = (res: EvalResult): boolean => res.ok && res.value === true;",
    );
    expect(file).toContain("export const authorizeAction");
    expect(file).toContain("export const recordAllowed");
    expect(file).toContain("export const filterRead");
    expect(file).toContain("export const stripWrites");
  });
  it("embeds the grants and the column->field map", () => {
    expect(file).toContain('"Editor"');
    expect(file).toContain('"secret_notes": "secretNotes"');
  });
  it("wires a condition registry keyed by the grant record-condition key", () => {
    expect(file).toContain("c__Editor__Article__record");
  });
});
