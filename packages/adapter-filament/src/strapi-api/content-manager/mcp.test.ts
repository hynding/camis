import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";
import { strapiApiBundle } from "../__fixtures__/strapi-api";

// Strapi 5's MCP server: strapi-mcp-vectors.mjs runs the recorded requests in a booted app.
describe("the MCP server", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const paths = result.files.map((f) => f.path);
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("answers POST /mcp and refuses its other methods with a JSON-RPC error", () => {
    const routes = content("routes/admin.php");
    expect(routes).toContain("Route::post('/mcp', [StrapiMcpController::class, 'handle']);");
    expect(routes).toContain(
      "Route::match(['GET', 'PUT', 'PATCH', 'DELETE'], '/mcp', [StrapiMcpController::class, 'notAllowed']);",
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "app/Http/Controllers/StrapiMcpController.php",
        "app/Support/StrapiMcpServer.php",
        "app/Support/StrapiMcpSchema.php",
        "app/Support/StrapiMcpContentManager.php",
        "app/Support/StrapiMcpMedia.php",
      ]),
    );
  });

  it("is off until the deployment turns it on, as Strapi's server.mcp.enabled is", () => {
    expect(content("config/camis.php")).toContain(
      "'enabled' => (bool) env('CAMIS_MCP_ENABLED', false),",
    );
  });

  it("lists the content-manager's tools with what their handlers read", () => {
    const { types, tools } = JSON.parse(content("resources/strapi/mcp.json")) as {
      types: Record<string, Record<string, unknown>>;
      tools: { name: string; uid: string; operation: string }[];
    };
    expect(tools.find((t) => t.name === "publish_post")).toMatchObject({
      uid: "api::post.post",
      operation: "publish",
    });
    expect(types["api::post.post"]).toMatchObject({
      model: "App\\Models\\Post",
      serializer: "App\\Http\\Serializers\\PostSerializer",
      kind: "collectionType",
      draftAndPublish: true,
      localized: false,
      attributes: {
        title: { kind: "scalar" },
        author: { kind: "relation", many: false },
        topics: { kind: "relation", many: true },
        image: { kind: "media" },
      },
    });
    expect(types["api::page.page"]!.populate).toEqual({ panel: { populate: { items: true } } });
    expect(types["api::review.review"]!.attributes).toMatchObject({
      moderatorNote: { kind: "scalar", private: true },
      flaggedBy: { kind: "relation", private: true },
    });
    expect(types["api::review.review"]!.populate).not.toHaveProperty("flaggedBy");
  });

  it("lists the Media Library's tools first, as Strapi registers them first", () => {
    const { types, tools } = JSON.parse(content("resources/strapi/mcp.json")) as {
      types: Record<string, Record<string, unknown>>;
      tools: { name: string; uid: string; operation: string }[];
    };
    expect(tools[0]).toMatchObject({
      name: "media_list_assets",
      uid: "plugin::upload.file",
      operation: "list_assets",
    });
    expect(types["plugin::upload.file"]).toEqual({ model: "App\\Models\\File" });
  });

  it("is left out of an app without roles, which has no admin tokens to sign in with", () => {
    const open = filamentAdapter.generate(
      { ...strapiApiBundle, roles: [] },
      { projectName: "oyl", apiStyle: "strapi" },
    );
    expect(open.files.map((f) => f.path)).not.toContain("resources/strapi/mcp.json");
  });
});
