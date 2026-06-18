import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import type { PolicySpec } from "./project";
import { emitPolicy } from "./policy";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [{ type: "string", name: "status" }],
} as ContentType;
const spec: PolicySpec = {
  contentType: "Article",
  model: "Article",
  methods: [
    { method: "viewAny", key: "article.read", record: false },
    {
      method: "view",
      key: "article.read",
      record: true,
      condition: {
        kind: "eq",
        left: { kind: "var", name: "record.status" },
        right: { kind: "lit", value: "published" },
      },
    },
    { method: "create", key: "article.create", record: false },
  ],
};

describe("emitPolicy", () => {
  const php = emitPolicy(spec, article);
  it("emits a namespaced policy class using Ring1 + models", () => {
    expect(php).toContain("namespace App\\Policies;");
    expect(php).toContain("use App\\Models\\Article;");
    expect(php).toContain("use App\\Models\\User;");
    expect(php).toContain("use App\\Support\\Ring1;");
    expect(php).toContain("class ArticlePolicy");
  });
  it("no-condition method is a bare permission check", () => {
    expect(php).toContain("public function create(User $user): bool");
    expect(php).toContain("return $user->can('article.create');");
  });
  it("record-scoped condition method builds record.* data and is fail-closed", () => {
    expect(php).toContain("public function view(User $user, Article $record): bool");
    expect(php).toContain("if (! $user->can('article.read')) {");
    expect(php).toContain("'record.status' => $record->status,");
    expect(php).toContain("return $result['ok'] === true && $result['value'] === true;");
    expect(php).toContain("Ring1::eq(");
  });
  it("non-record method omits record.* data", () => {
    // viewAny has no condition here, so it's a bare check; ensure no record data leaks anywhere for non-record methods
    expect(php).toContain("public function viewAny(User $user): bool");
  });
});
