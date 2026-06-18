import { describe, expect, it } from "vitest";
import type { Hook } from "@camis/ir-schema";
import { emitHookContract } from "./contract";

const h: Hook = {
  name: "TransformTitle",
  trigger: "onPublish",
  contentType: "Article",
  input: [{ name: "title", type: "string" }],
  output: [{ name: "title", type: "string" }],
};

describe("emitHookContract (strapi)", () => {
  const ts = emitHookContract(h);
  it("emits typed input/output and the hook interface, marked generated", () => {
    expect(ts).toContain("@camis:generated");
    expect(ts).toContain("export interface TransformTitleInput {");
    expect(ts).toContain("  title: string;");
    expect(ts).toContain("export interface TransformTitleHook {");
    expect(ts).toContain("run(input: TransformTitleInput): TransformTitleOutput;");
  });
});
