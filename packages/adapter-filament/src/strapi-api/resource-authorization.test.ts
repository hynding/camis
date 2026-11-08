import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Filament's create, edit and view pages authorize through the resource's
// get*AuthorizationResponse() methods (since 5.11.2), so a resource that only overrides can*()
// would let its pages fall back to the model policy. Every builtin override sits on the response.
describe("resource authorization overrides", () => {
  const strapi = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => strapi.files.find((f) => f.path === p)!.content;
  const resources = [
    "app/Filament/Resources/Homepages/HomepageResource.php",
    "app/Filament/Resources/Users/UserResource.php",
    "app/Filament/Resources/Roles/RoleResource.php",
    "app/Filament/Resources/ApiTokens/ApiTokenResource.php",
    "app/Filament/Resources/TransferTokens/TransferTokenResource.php",
    "app/Filament/Resources/Webhooks/WebhookResource.php",
  ];

  it.each(resources)("%s overrides responses, not can*()", (path) => {
    const resource = content(path);
    expect(resource).not.toMatch(/function can(ViewAny|Create|Edit|Delete|View)\(/);
    expect(resource).toMatch(
      /function get(ViewAny|Create|Edit|Delete|View)AuthorizationResponse\(/,
    );
    expect(resource).toContain("use Illuminate\\Auth\\Access\\Response;");
  });

  it("lets a single type's create page through on the update grant", () => {
    expect(content("app/Filament/Resources/Homepages/HomepageResource.php")).toContain(
      "return Gate::inspect('update', new Homepage());",
    );
  });
});
