import { describe, expect, it } from "vitest";
import type { Hook } from "@camis/ir-schema";
import { emitHookStub } from "./stub";
import { emitHookLifecycle } from "./lifecycles";

const h: Hook = {
  name: "TransformTitle",
  trigger: "onPublish",
  contentType: "Article",
  input: [{ name: "title", type: "string" }],
  output: [{ name: "title", type: "string" }],
};

describe("strapi hook stub + lifecycle", () => {
  it("stub is unmarked, imports the contract, returns a typed impl", () => {
    const s = emitHookStub(h);
    expect(s).not.toContain("@camis:generated");
    expect(s).toContain(
      'import type { TransformTitleHook } from "./contracts/transform-title.contract";',
    );
    expect(s).toContain("export const transformTitle: TransformTitleHook = {");
  });
  it("lifecycle is marked, invokes the hook on publish and applies output", () => {
    const l = emitHookLifecycle(h);
    expect(l).toContain("@camis:generated");
    expect(l).toContain('import { transformTitle } from "../../../../hooks/transform-title";');
    expect(l).toContain("if (data && data.publishedAt) {");
    expect(l).toContain("data.title = out.title;");
  });
});
