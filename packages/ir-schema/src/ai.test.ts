import { describe, expect, it } from "vitest";
import { ai, aiPlaceholders } from "./ai";

describe("ai schema", () => {
  it("accepts a minimal ai block (model optional)", () => {
    expect(ai.safeParse({ prompt: "Summarize: {{body}}", trigger: "onCreate" }).success).toBe(true);
  });
  it("accepts an explicit model + onCreateOrUpdate trigger", () => {
    expect(
      ai.safeParse({ model: "claude-haiku-4-5", prompt: "x {{a}}", trigger: "onCreateOrUpdate" })
        .success,
    ).toBe(true);
  });
  it("rejects an empty prompt and an unknown trigger", () => {
    expect(ai.safeParse({ prompt: "", trigger: "onCreate" }).success).toBe(false);
    expect(ai.safeParse({ prompt: "x", trigger: "never" }).success).toBe(false);
  });
});

describe("aiPlaceholders", () => {
  it("extracts unique field names from {{placeholders}}", () => {
    expect(aiPlaceholders("Title {{title}}, body {{body}}, again {{title}}")).toEqual([
      "title",
      "body",
    ]);
  });
  it("tolerates whitespace and returns [] when none", () => {
    expect(aiPlaceholders("a {{ name }} b")).toEqual(["name"]);
    expect(aiPlaceholders("no placeholders")).toEqual([]);
  });
});
