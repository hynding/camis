import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { expressAdapter } from "./generate";

const bundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
    ],
    components: [],
    hooks: [
      {
        name: "Slugify",
        trigger: "beforeCreate",
        contentType: "Article",
        input: [{ name: "title", type: "string" }],
        output: [{ name: "title", type: "string" }],
      },
    ],
    policies: [{ name: "IsOwner", contentType: "Article" }],
    middlewares: [{ name: "AuditTrail", contentType: "Article" }],
    schedules: [{ name: "SendDigest", cron: "0 7 * * *" }],
    endpoints: [
      { name: "ArticleLike", contentType: "Article", method: "POST", path: "/articles/:id/like" },
    ],
  },
  roles: [],
};

describe("express custom code", () => {
  it("reports each hook, policy, middleware, schedule and endpoint it cannot run", () => {
    const gaps = expressAdapter.generate(bundle, { projectName: "blog" }).gaps.gaps;
    expect(
      gaps.filter((g) =>
        ["hook", "policy", "middleware", "schedule", "endpoint"].includes(g.feature),
      ),
    ).toEqual([
      {
        feature: "hook",
        location: { contentType: "Article", rule: "Slugify" },
        severity: "downgrade",
        message: 'the Express target runs no hooks; "Slugify" (beforeCreate) is not wired',
      },
      {
        feature: "policy",
        location: { contentType: "Article", rule: "IsOwner" },
        severity: "downgrade",
        message: 'the Express target runs no route policies; "IsOwner" is not wired',
      },
      {
        feature: "middleware",
        location: { contentType: "Article", rule: "AuditTrail" },
        severity: "downgrade",
        message: 'the Express target runs no route middlewares; "AuditTrail" is not wired',
      },
      {
        feature: "schedule",
        location: { rule: "SendDigest" },
        severity: "downgrade",
        message: 'the Express target runs no schedules; "SendDigest" is not wired',
      },
      {
        feature: "endpoint",
        location: { contentType: "Article", rule: "ArticleLike" },
        severity: "downgrade",
        message:
          'the Express target runs no endpoints; "ArticleLike" (POST /articles/:id/like) is not wired',
      },
    ]);
  });
});

describe("express content API actions", () => {
  it("reports a type serving only some actions, since it routes every one", () => {
    const restricted: IrBundle = {
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Address",
            kind: "collection",
            options: { apiActions: ["list", "read"] },
            fields: [{ type: "string", name: "city" }],
          },
        ],
        components: [],
      },
      roles: [],
    };
    const gaps = expressAdapter.generate(restricted, { projectName: "blog" }).gaps.gaps;
    expect(gaps.filter((g) => g.feature === "apiActions")).toEqual([
      {
        feature: "apiActions",
        location: { contentType: "Address" },
        severity: "downgrade",
        message:
          "the Express target routes every action; Address serves only list, read, so its create, update and delete routes are open to whoever its roles let in",
      },
    ]);
  });

  it("reports a type's public actions, which it still checks against the caller's grants", () => {
    const opened: IrBundle = {
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Address",
            kind: "collection",
            options: { publicApiActions: ["list", "read"] },
            fields: [{ type: "string", name: "city" }],
          },
        ],
        components: [],
      },
      roles: [],
    };
    const gaps = expressAdapter.generate(opened, { projectName: "blog" }).gaps.gaps;
    expect(gaps.filter((g) => g.feature === "publicApiActions")).toEqual([
      {
        feature: "publicApiActions",
        location: { contentType: "Address" },
        severity: "downgrade",
        message:
          "the Express target checks the caller's grants on every route; Address opens list and read to anyone, so grant them to its roles instead",
      },
    ]);
  });
});
