import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi 5's webhooks (the admin's Webhooks settings and the entry.* and media.* events that fire
// them); webhook-vectors.json, recorded from strapi-php, is the behaviour.
describe("webhooks", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("keeps webhooks in Strapi's own table", () => {
    const migration = content(
      "database/migrations/0001_01_02_000006_create_strapi_webhooks_table.php",
    );
    expect(migration).toContain("Schema::create('strapi_webhooks'");
    expect(migration).toContain("$table->json('events')->nullable();");
    const model = content("app/Models/StrapiWebhook.php");
    expect(model).toContain("'events' => 'array',");
  });

  it("names every event Strapi sends, media's included", async () => {
    const webhooks = content("app/Support/StrapiWebhooks.php");
    expect(webhooks).toContain("'entry.draft-discard',");
    expect(webhooks).toContain("'media.delete',");
    expect(webhooks).toContain(
      "\\App\\Models\\Book::class => ['api::book.book', 'book', \\App\\Http\\Serializers\\BookSerializer::class],",
    );
    await expect(webhooks).toMatchFileSnapshot("./__golden__/strapi-api/StrapiWebhooks.php");
  });

  it("sends after the response, so a shared host needs no worker", () => {
    const webhooks = content("app/Support/StrapiWebhooks.php");
    expect(webhooks).toContain("app()->terminating(fn () => self::flush());");
    expect(webhooks).toContain("DB::afterCommit(");
    expect(webhooks).toContain("->timeout(10)");
  });

  it("hears every content type's writes and the media library's", () => {
    const concern = content("app/Models/Concerns/EmitsStrapiEvents.php");
    expect(concern).toContain("static::saved(fn (Model $row) => StrapiWebhooks::saved($row));");
    expect(content("app/Models/Book.php")).toContain("use EmitsStrapiEvents;");
    expect(content("app/Models/File.php")).toContain("use EmitsStrapiEvents;");
  });

  it("sends publication events from the documents, not as the rows they copy", () => {
    const documents = content("app/Support/StrapiDocuments.php");
    expect(documents).toContain("StrapiWebhooks::entry('entry.publish', $published);");
    expect(documents).toContain("StrapiWebhooks::entry('entry.unpublish', $published);");
    expect(documents).toContain("StrapiWebhooks::entry('entry.draft-discard', $draft);");
  });

  it("populates an entry for its webhooks whatever the caller may read", () => {
    const query = content("app/Support/StrapiQuery.php");
    expect(query).toContain("public static function unrestricted(\\Closure $read): mixed");
  });

  it("manages webhooks on the admin's Webhooks page, refusing a local url in production", () => {
    const resource = content("app/Filament/Resources/Webhooks/WebhookResource.php");
    expect(resource).toContain("CheckboxList::make('events')");
    expect(resource).toContain(
      "Url is not supported because it isn't reachable over the public internet",
    );
    const edit = content("app/Filament/Resources/Webhooks/Pages/EditWebhook.php");
    expect(edit).toContain("StrapiWebhooks::run($this->record, 'trigger-test')");
  });

  it("adds Strapi's default headers from the config", () => {
    expect(content("config/camis.php")).toContain("'webhooks' => ['default_headers' => []],");
  });
});
