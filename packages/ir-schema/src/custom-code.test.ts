import { describe, expect, it } from "vitest";
import { irDocument } from "./document";
import { endpoint, hook } from "./hooks";

const base = {
  version: 1,
  components: [],
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
};

const issues = (doc: unknown): { code: unknown; path: (string | number)[] }[] => {
  const r = irDocument.safeParse(doc);
  return r.success
    ? []
    : r.error.issues.map((i) => ({
        code: (i as { params?: { irCode?: unknown } }).params?.irCode,
        path: i.path,
      }));
};

describe("lifecycle hooks", () => {
  const lifecycle = (trigger: string, output: unknown[] = []) => ({
    name: "Stamp",
    trigger,
    contentType: "Article",
    input: [{ name: "title", type: "string" }],
    output,
  });

  it.each([
    "beforeCreate",
    "afterCreate",
    "beforeUpdate",
    "afterUpdate",
    "beforeDelete",
    "afterDelete",
  ])("accepts a %s hook", (trigger) => {
    expect(hook.safeParse(lifecycle(trigger)).success).toBe(true);
  });

  it("lets a hook that runs before the write change the record", () => {
    for (const trigger of ["onPublish", "beforeCreate", "beforeUpdate"]) {
      expect(hook.safeParse(lifecycle(trigger, [{ name: "title", type: "string" }])).success).toBe(
        true,
      );
    }
  });

  it("refuses an output on a hook that runs after the write or on a delete", () => {
    for (const trigger of ["afterCreate", "afterUpdate", "beforeDelete", "afterDelete"]) {
      const r = hook.safeParse(lifecycle(trigger, [{ name: "title", type: "string" }]));
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(["output"]);
      expect(r.error?.issues[0]?.message).toBe(
        `a ${trigger} hook cannot change the record, so its output must be empty`,
      );
    }
  });

  it("refuses a hook field the content type does not have", () => {
    expect(
      issues({ ...base, hooks: [lifecycle("beforeCreate", [{ name: "slug", type: "string" }])] }),
    ).toEqual([{ code: "unknown_hook_field", path: ["hooks", 0, "output", 0, "name"] }]);
  });
});

describe("route policies and middlewares", () => {
  it("accepts a policy and a middleware on some or all of a type's actions", () => {
    expect(
      irDocument.safeParse({
        ...base,
        policies: [{ name: "IsOwner", contentType: "Article", actions: ["update", "delete"] }],
        middlewares: [{ name: "Audit", contentType: "Article" }],
      }).success,
    ).toBe(true);
  });

  it("refuses an action the content API does not have", () => {
    expect(
      irDocument.safeParse({
        ...base,
        policies: [{ name: "IsOwner", contentType: "Article", actions: ["publish"] }],
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown content type", () => {
    expect(issues({ ...base, middlewares: [{ name: "Audit", contentType: "Ghost" }] })).toEqual([
      { code: "unknown_hook_content_type", path: ["middlewares", 0, "contentType"] },
    ]);
  });
});

describe("schedules", () => {
  it("accepts a five-field cron expression", () => {
    for (const cron of ["0 * * * *", "*/15 9-17 * * 1-5", "0 0 1 jan,jul *"]) {
      expect(irDocument.safeParse({ ...base, schedules: [{ name: "Digest", cron }] }).success).toBe(
        true,
      );
    }
  });

  it("refuses an expression with seconds, or none at all", () => {
    for (const cron of ["0 0 * * * *", "hourly", ""]) {
      expect(irDocument.safeParse({ ...base, schedules: [{ name: "Digest", cron }] }).success).toBe(
        false,
      );
    }
  });
});

describe("Ring 2 names", () => {
  it("are unique across hooks, policies, middlewares and schedules", () => {
    expect(
      issues({
        ...base,
        policies: [{ name: "Guard", contentType: "Article" }],
        middlewares: [{ name: "Guard", contentType: "Article" }],
        schedules: [{ name: "Guard", cron: "0 * * * *" }],
      }),
    ).toEqual([
      { code: "duplicate_hook", path: ["middlewares", 0, "name"] },
      { code: "duplicate_hook", path: ["schedules", 0, "name"] },
    ]);
  });
});

describe("endpoints", () => {
  const like = {
    name: "ArticleLike",
    contentType: "Article",
    method: "POST",
    path: "/articles/:id/like",
  };

  it("keeps a route of its own with hand-written code behind it", () => {
    expect(
      issues({
        ...base,
        endpoints: [like, { ...like, name: "Ping", method: "GET", path: "/ping", public: true }],
      }),
    ).toEqual([]);
  });

  it("rejects a path that is not Strapi's /segment/:param form", () => {
    expect(endpoint.safeParse({ ...like, path: "articles/like" }).success).toBe(false);
    expect(endpoint.safeParse({ ...like, path: "/articles/{id}" }).success).toBe(false);
    expect(endpoint.safeParse({ ...like, method: "OPTIONS" }).success).toBe(false);
  });

  it("rejects an unknown type, a name another hook has, and a route another endpoint has", () => {
    expect(
      issues({
        ...base,
        policies: [{ name: "ArticleLike", contentType: "Article" }],
        endpoints: [
          { ...like, contentType: "Nope", name: "Other", path: "/other" },
          like,
          { ...like, name: "Again" },
        ],
      }),
    ).toEqual([
      { code: "unknown_hook_content_type", path: ["endpoints", 0, "contentType"] },
      { code: "duplicate_hook", path: ["endpoints", 1, "name"] },
      { code: "duplicate_endpoint_route", path: ["endpoints", 2, "path"] },
    ]);
  });
});
