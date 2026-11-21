import { describe, expect, it } from "vitest";
import { routeProblems, type ListedRoute } from "./route-guard";

const route = (extra: Partial<ListedRoute>): ListedRoute => ({
  method: "GET",
  path: "/notes",
  namespace: "api::note",
  handler: "api::note.note.find",
  auth: null,
  ...extra,
});
const allowlist = { "api::note.note.find": "scoped by enforcedController.find" };
const memberFinds = [{ role: "member", action: "api::note.note.find" }];

describe("routeProblems: the boot job's route guard", () => {
  it("passes a granted route the allowlist names, and skips one no role reaches", () => {
    expect(routeProblems([route({})], memberFinds, allowlist)).toEqual([]);
    expect(routeProblems([route({ handler: "api::note.note.delete" })], memberFinds, {})).toEqual(
      [],
    );
  });
  it("fails a granted route the allowlist does not name", () => {
    expect(routeProblems([route({})], memberFinds, {})).toEqual([
      "GET /notes: api::note.note.find (held by member) is not allowlisted",
    ]);
  });
  // users-permissions checks the route's scope, not its handler, and lets any authenticated
  // caller through a route that has none.
  it("fails a route with no scope (a function handler), as open to any authenticated caller", () => {
    expect(routeProblems([route({ handler: null, path: "/custom" })], [], allowlist)).toEqual([
      "GET /custom: no scope, so open to any authenticated caller; allowlist it as GET /custom",
    ]);
    expect(
      routeProblems([route({ handler: null, path: "/custom" })], [], { "GET /custom": "why" }),
    ).toEqual([]);
  });
  it("requires every scope action and the handler when a scope differs from the handler", () => {
    const odd = route({
      handler: "api::note.note.purge",
      auth: { scope: ["api::note.note.find"] },
    });
    expect(routeProblems([odd], memberFinds, allowlist)).toEqual([
      "GET /notes: api::note.note.purge (handler, held through its scope by member) is not allowlisted",
    ]);
    const relative = route({
      namespace: "plugin::upload",
      handler: "content-api.find",
      auth: { scope: ["content-api.find"] },
    });
    expect(
      routeProblems(
        [relative],
        [{ role: "member", action: "plugin::upload.content-api.find" }],
        {},
      ),
    ).toEqual(["GET /notes: plugin::upload.content-api.find (held by member) is not allowlisted"]);
  });
  it("fails an auth: false route the allowlist does not name, as open to anyone", () => {
    expect(routeProblems([route({ auth: false })], [], {})).toEqual([
      "GET /notes: api::note.note.find (auth: false, open to anyone) is not allowlisted",
    ]);
    expect(routeProblems([route({ auth: false })], [], allowlist)).toEqual([]);
  });
});
