import { describe, expect, it } from "vitest";
import { permissionKey, POLICY_METHODS } from "./keys";

describe("keys", () => {
  it("builds a snake-singular dotted permission key", () => {
    expect(permissionKey("Article", "read")).toBe("article.read");
    expect(permissionKey("BlogPost", "create")).toBe("blog_post.create");
  });
  it("maps read to viewAny + view, with record-scopedness", () => {
    expect(POLICY_METHODS.read).toEqual([
      { method: "viewAny", record: false },
      { method: "view", record: true },
    ]);
    expect(POLICY_METHODS.update).toEqual([{ method: "update", record: true }]);
  });
});
