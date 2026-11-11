import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "../../generate";

// Strapi's core router `only`/`except`: a type serves only the content API actions it lists.
const bundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Address",
        kind: "collection",
        options: { apiActions: ["list", "read"] },
        fields: [{ type: "string", name: "city" }],
      },
      {
        name: "Homepage",
        kind: "single",
        options: { apiActions: ["read"] },
        fields: [{ type: "string", name: "headline" }],
      },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "name" }] },
    ],
    components: [],
  },
  roles: [{ name: "Editor", admin: true, grants: [{ contentType: "Address", actions: ["read"] }] }],
};

const generate = (apiStyle: "laravel" | "strapi") =>
  filamentAdapter.generate(bundle, { projectName: "blog", apiStyle, documentation: true });
const file = (apiStyle: "laravel" | "strapi", path: string): string =>
  generate(apiStyle).files.find((f) => f.path === path)!.content;

describe("filament content API actions", () => {
  it("strapi: routes only the actions a type serves", () => {
    const routes = file("strapi", "routes/api.php");
    expect(routes).toContain("Route::get('/addresses', [AddressApiController::class, 'index']);");
    expect(routes).toContain(
      "Route::get('/addresses/{key}', [AddressApiController::class, 'show']);",
    );
    expect(routes).not.toContain("[AddressApiController::class, 'store']");
    expect(routes).not.toContain("[AddressApiController::class, 'update']");
    expect(routes).not.toContain("[AddressApiController::class, 'destroy']");
    expect(routes).toContain("Route::get('/homepage', [HomepageApiController::class, 'single']);");
    expect(routes).not.toContain("[HomepageApiController::class, 'putSingle']");
    expect(routes).toContain("Route::delete('/tags/{key}', [TagApiController::class, 'destroy']);");
  });

  it("strapi: documents only the operations a type serves", () => {
    const paths = JSON.parse(file("strapi", "public/documentation/openapi.json")).paths;
    expect(Object.keys(paths["/addresses"])).toEqual(["get"]);
    expect(Object.keys(paths["/addresses/{id}"])).toEqual(["get"]);
    expect(Object.keys(paths["/homepage"])).toEqual(["get"]);
    expect(Object.keys(paths["/tags/{id}"])).toEqual(["get", "put", "delete"]);
  });

  it("laravel: keeps a resource to the actions its type serves", () => {
    const routes = file("laravel", "routes/api.php");
    expect(routes).toContain(
      "Route::apiResource('addresses', AddressApiController::class)->only(['index', 'show']);",
    );
    expect(routes).toContain("Route::apiResource('tags', TagApiController::class);");
  });
});
