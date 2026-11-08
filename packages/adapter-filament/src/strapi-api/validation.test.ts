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

  it("checks a unique field (a uid always is) against its column, a repeatable's against its items' table", () => {
    const ticket = content("app/Http/Controllers/Api/Generated/TicketApiController.php");
    expect(ticket).toContain(
      "'serial' => ['type' => 'string', 'unique' => ['column' => 'serial']],",
    );
    expect(ticket).toContain("'slug' => ['type' => 'uid', 'unique' => ['column' => 'slug']],");
    expect(ticket).toContain("'seat' => ['type' => 'integer', 'unique' => ['column' => 'seat']],");
    expect(ticket).toMatch(
      /'codes' => \[\n\s+'type' => 'component',\n\s+'repeatable' => true,\n\s+'fields' => \[\n\s+'value' => \['type' => 'string', 'unique' => \['relation' => '\w+', 'column' => 'value'\]\],/,
    );
    // A field without a unique constraint carries none.
    expect(ticket).toContain("'body' => ['type' => 'blocks'],");
    expect(controller).toContain(
      "'title' => ['type' => 'string', 'required' => true, 'minLength' => 3, 'maxLength' => 20],",
    );
  });

  it("checks a unique value among the other documents' published rows, the written one left out", () => {
    const ticket = content("app/Http/Controllers/Api/Generated/TicketApiController.php");
    const store = ticket.slice(ticket.indexOf("public function store("));
    expect(store).toContain("unique: fn (): Builder => $this->others($request, null)");
    const update = ticket.slice(ticket.indexOf("public function update("));
    expect(update).toContain("unique: fn (): Builder => $this->others($request, $key)");
    expect(ticket).toContain(
      "return Ticket::query()->when($key !== null, fn (Builder $q) => $q->where(self::KEY, '!=', $key));",
    );
    // A type without a unique field needs no others().
    expect(content("app/Http/Controllers/Api/Generated/GenreApiController.php")).not.toContain(
      "function others(",
    );
  });

  it("checks a required relation and file by whether the write keeps one, as strictRelations does", () => {
    const ticket = content("app/Http/Controllers/Api/Generated/TicketApiController.php");
    expect(ticket).toContain(
      "'venue' => ['type' => 'relation', 'required' => true, 'toOne' => true],",
    );
    expect(ticket).toContain(
      "'badge' => ['type' => 'media', 'required' => true, 'toOne' => true],",
    );
    expect(content("config/camis.php")).toContain(
      "'strict_relations' => (bool) env('CAMIS_STRICT_RELATIONS', true),",
    );
  });

  it("checks a blocks field's document tree", () => {
    const ticket = content("app/Http/Controllers/Api/Generated/TicketApiController.php");
    expect(ticket).toContain("'body' => ['type' => 'blocks'],");
  });

  it("ships the validator", async () => {
    expect(content("app/Support/StrapiValidator.php")).toContain("final class StrapiValidator");
    await expect(content("app/Support/StrapiValidator.php")).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiValidator.php",
    );
  });
});
