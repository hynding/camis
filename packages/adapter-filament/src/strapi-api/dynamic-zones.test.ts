import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi 5's dynamic zones on the laravel storage layout; dynamic-zone-vectors.json, recorded
// from strapi-php, is the behaviour.
describe("dynamic zones", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path.endsWith(p))!.content;

  it("keeps each member's items in their own table, in the zone's order", () => {
    const migration = content("_create_landings_blocks_hero_table.php");
    expect(migration).toContain("$table->unsignedInteger('position');");
    expect(migration).toContain("$table->string('heading')");
    expect(migration).toContain("$table->bigInteger('price_minor')->nullable();");
    expect(content("app/Models/Landing.php")).toContain("public function blocksHero(): HasMany");
    expect(content("_create_landings_table.php")).not.toContain("'blocks'");
    expect(content("app/Filament/Resources/Landings/Schemas/LandingForm.php")).not.toContain(
      "TextInput::make('blocks')",
    );
  });

  it("is no capability gap", () => {
    expect(result.gaps.gaps.filter((g) => g.feature === "dynamicZone")).toEqual([]);
  });

  it("sends each item with its component's uid, only when populate names the zone", async () => {
    const serializer = content("app/Http/Serializers/LandingSerializer.php");
    expect(serializer).toContain("public const COMPONENTS = ['blocks'];");
    expect(serializer).toContain("'__component' => 'shared.hero'");
    expect(serializer).toContain(
      "'shared.hero' => ['relation' => 'blocksHero', 'components' => ['price']],",
    );
    await expect(serializer).toMatchFileSnapshot("./__golden__/strapi-api/LandingSerializer.php");
  });

  it("refuses an item naming a component the project does not have, as Strapi words it", () => {
    const zones = content("app/Support/StrapiZones.php");
    expect(zones).toContain(
      "private const COMPONENTS = ['shared.frame', 'shared.hero', 'shared.line', 'shared.money', 'shared.panel', 'shared.quantity'];",
    );
    expect(zones).toContain("__component must be one of the following values: ");
  });

  it("narrows a zone by populate's on fragments", () => {
    expect(content("app/Support/StrapiPopulate.php")).toContain(
      "private static function zone(array $items, string $key, array $sub, string $serializer): array",
    );
  });

  it("publishes a zone with its document", () => {
    expect(content("app/Support/StrapiDocuments.php")).toContain(
      "foreach ($serializer::ZONES as $members) {",
    );
  });

  it("edits a zone in the admin with a builder of its components", () => {
    const form = content("app/Filament/Resources/Landings/Schemas/LandingForm.php");
    expect(form).toContain("Builder::make('blocks')");
    expect(form).toContain("Block::make('shared.hero')->label('Hero')");
    expect(form).toContain("StrapiZones::sync($record, 'blocks'");
  });
});
