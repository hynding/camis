import { describe, expect, it } from "vitest";
import type { ContentType, Hook } from "@camis/ir-schema";
import { emitHookStub } from "./stub";
import { emitHookObserver } from "./observer";

const h: Hook = {
  name: "TransformTitle",
  trigger: "onPublish",
  contentType: "Article",
  input: [{ name: "title", type: "string" }],
  output: [{ name: "title", type: "string" }],
};
const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [{ type: "string", name: "title" }],
} as ContentType;

describe("filament hook stub + observer", () => {
  it("stub is unmarked and implements the contract", () => {
    const s = emitHookStub(h);
    expect(s).not.toContain("@camis:generated");
    expect(s).toContain("final class TransformTitle implements TransformTitleHook");
    expect(s).toContain("return $input;");
  });
  it("observer is marked, fires on publish transition, applies output", () => {
    const o = emitHookObserver(h, article);
    expect(o).toContain("@camis:generated");
    expect(o).toContain("class ArticleObserver");
    expect(o).toContain(
      "if ($record->wasChanged('published_at') && $record->published_at !== null) {",
    );
    expect(o).toContain("$record->title = $out['title'];");
  });
});
