import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";
import { strapiApiBundle } from "../__fixtures__/strapi-api";

// Strapi's email plugin's content API route, POST /api/email (plugin::email.email.send). Strapi
// ships no role with that action, and camis's roles come from the IR, so an API token that holds
// it (full access, or custom with the action) is what sends.
describe("Strapi's email send route", () => {
  const generate = (bundle = strapiApiBundle) =>
    filamentAdapter.generate(bundle, { projectName: "oyl", apiStyle: "strapi" });
  const strapi = generate();
  const content = (p: string) => {
    const file = strapi.files.find((f) => f.path === p);
    if (file === undefined) throw new Error(`not generated: ${p}`);
    return file.content;
  };

  it("routes POST /email to the email controller's send", () => {
    const routes = content("routes/api.php");
    expect(routes).toContain("use App\\Http\\Controllers\\Api\\EmailController;");
    expect(routes).toContain("Route::post('/email', [EmailController::class, 'send']);");
  });

  it("names the route's action for API tokens as Strapi does", () => {
    expect(content("app/Support/StrapiApiTokens.php")).toContain(
      "'App\\Http\\Controllers\\Api\\EmailController' => [\n            'send' => 'plugin::email.email.send',\n        ],",
    );
  });

  it("sends through Strapi's email service only for a token holding the action", async () => {
    const controller = content("app/Http/Controllers/Api/EmailController.php");
    expect(controller).toContain("if (! StrapiApiTokens::active()) {");
    expect(controller).toContain("throw new StrapiError(403, 'ForbiddenError', 'Forbidden');");
    expect(controller).toContain("StrapiEmail::send($options);");
    expect(controller).toContain("return response()->json(new \\stdClass());");
    await expect(controller).toMatchFileSnapshot("../__golden__/strapi-api/EmailController.php");
  });

  it("serves no send route without roles, where nothing would guard it", () => {
    const open = generate({ ...strapiApiBundle, roles: [] });
    const routes = open.files.find((f) => f.path === "routes/api.php")!.content;
    expect(routes).not.toContain("EmailController");
    expect(open.files.map((f) => f.path)).not.toContain(
      "app/Http/Controllers/Api/EmailController.php",
    );
  });
});
