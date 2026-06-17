import { describe, expect, it } from "vitest";
import type { GenerateAdapter, GeneratedFile, GenerationResult } from "./types";

describe("kernel types", () => {
  it("a GeneratedFile and a minimal adapter are well-typed", () => {
    const file: GeneratedFile = { path: "src/x.ts", content: "x" };
    const adapter: GenerateAdapter = {
      target: "noop",
      generate: (): GenerationResult => ({
        files: [file],
        manifest: { generator: "camis", files: [] },
        gaps: { target: "noop", gaps: [] },
      }),
    };
    expect(adapter.target).toBe("noop");
    expect(file.mode).toBeUndefined();
  });
});
