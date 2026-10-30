import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi's entity validator on REST and GraphQL writes. validation-vectors.json, recorded from
// strapi-php, is the behaviour: each message, the order errors come in, and what a draft skips.
const result = filamentAdapter.generate(strapiApiBundle, {
  projectName: "oyl",
  apiStyle: "strapi",
});
const content = (p: string) => result.files.find((f) => f.path === p)?.content ?? "";
const controller = content("app/Http/Controllers/Api/Generated/SubmissionApiController.php");
const method = (name: string) =>
  controller.slice(
    controller.indexOf(`public function ${name}(`),
    controller.indexOf("\n    }\n", controller.indexOf(`public function ${name}(`)),
  );

describe("entity validation", () => {
  it("checks each written field against its Strapi attribute, a component's by their path", () => {
    expect(controller).toContain(
      "'title' => ['type' => 'string', 'required' => true, 'minLength' => 3, 'maxLength' => 20],",
    );
    expect(controller).toContain("'code' => ['type' => 'string', 'regex' => '^[A-Z]{3}-\\\\d+$'],");
    expect(controller).toContain(
      "'kind' => ['type' => 'enumeration', 'enum' => ['alpha', 'beta']],",
    );
    expect(controller).toContain("'rating' => ['type' => 'integer', 'min' => 1, 'max' => 5],");
    expect(controller).toMatch(
      /'lines' => \[\n\s+'type' => 'component',\n\s+'repeatable' => true,\n\s+'fields' => \[\n\s+'label' => \['type' => 'string', 'required' => true\],/,
    );
  });

  it("validates a write before it is stored: a create as a creation, an update as an update", () => {
    const store = method("store");
    expect(store.indexOf("StrapiValidator::validate(")).toBeGreaterThan(-1);
    expect(store.indexOf("StrapiValidator::validate(")).toBeLessThan(store.indexOf("fromWire"));
    expect(store).toContain("self::RULES, creating: true");
    const update = method("update");
    expect(update.indexOf("StrapiValidator::validate(")).toBeLessThan(update.indexOf("->save()"));
    expect(update).toContain("self::RULES, creating: false");
  });

  it("skips what Strapi skips for a draft", () => {
    const post = content("app/Http/Controllers/Api/Generated/PostApiController.php");
    expect(post).toContain("draft: StrapiDocuments::draftOnly($request->query())");
  });

  it("ships the validator", async () => {
    expect(content("app/Support/StrapiValidator.php")).toContain("final class StrapiValidator");
    await expect(content("app/Support/StrapiValidator.php")).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiValidator.php",
    );
  });
});
