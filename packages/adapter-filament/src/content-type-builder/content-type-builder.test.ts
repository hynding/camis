import { stableJson } from "@camis/adapter-kernel";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "../strapi-api/__fixtures__/strapi-api";

// Strapi's Content-Type Builder: every type, component and field of the content model, read-only
// in production, and in development (`camis develop`) an editor that writes the IR and rebuilds.
describe("the Content-Type Builder", () => {
  const strapi = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const paths = strapi.files.map((f) => f.path);
  const content = (p: string) => {
    const file = strapi.files.find((f) => f.path === p);
    if (file === undefined) throw new Error(`not generated: ${p}`);
    return file.content;
  };

  it("ships the content model the app was built from, for the read-only builder", () => {
    expect(content("resources/camis/schema.json")).toBe(stableJson(strapiApiBundle.document));
  });

  it("is a main menu item beside the Content Manager, as Strapi's plugin is", () => {
    const page = content("app/Filament/Pages/ContentTypeBuilder.php");
    expect(page).toContain("protected static ?string $navigationLabel = 'Content-Type Builder';");
    expect(page).toContain("protected static ?string $slug = 'content-type-builder';");
    expect(page).not.toContain("$navigationGroup");
  });

  it("lists collection types, single types and components by category in its side menu", () => {
    const page = content("app/Filament/Pages/ContentTypeBuilder.php");
    expect(page).toContain("$item($node, 'contentType', 'Collection Types')");
    expect(page).toContain("$item($node, 'contentType', 'Single Types')");
    expect(page).toContain("$item($node, 'component', 'Components · '.$category)");
  });

  // The model is no secret, but Strapi gates its builder behind its own permission; camis gives it
  // to whoever may change the admin's settings, as its other settings pages do.
  it("is for the users who may change settings when the project has roles", () => {
    expect(content("app/Filament/Pages/ContentTypeBuilder.php")).toContain(
      "return auth()->user()?->can('user.update') ?? false;",
    );
    const open = filamentAdapter.generate(
      { ...strapiApiBundle, roles: [] },
      { projectName: "oyl", apiStyle: "strapi" },
    );
    expect(
      open.files.find((f) => f.path === "app/Filament/Pages/ContentTypeBuilder.php")?.content,
    ).toContain("return true;");
  });

  it("edits only in development, through `camis develop`'s project and build command", () => {
    const config = content("config/content-type-builder.php");
    expect(config).toContain("'project' => env('CAMIS_PROJECT_CONFIG'),");
    expect(config).toContain("'build_command' => env('CAMIS_BUILD_COMMAND'),");
    const builder = content("app/Support/ContentTypeBuilder.php");
    expect(builder).toContain(
      "if (! app()->environment((array) config('content-type-builder.environments', ['local']))) {",
    );
    expect(config).toContain("'environments' => ['local'],");
    // A failed build puts the content model back: the IR's validator is the guardrail.
    expect(builder).toContain("camis build failed, so the content model was left as it was");
  });

  it("brings the database up to a rebuilt app without losing its data", () => {
    expect(paths).toContain("app/Console/Commands/CamisSchemaSync.php");
    expect(content("app/Console/Commands/CamisSchemaSync.php")).toContain(
      "protected $signature = 'camis:schema-sync {--force : Run outside APP_ENV=local}';",
    );
    expect(content("app/Support/CamisSchemaSync.php")).toContain(
      "preg_replace('/^\\d{4}_\\d{2}_\\d{2}_\\d{6}_/', '', $migration)",
    );
  });

  it("emits its PHP as the golden files", async () => {
    for (const [path, golden] of [
      ["app/Filament/Pages/ContentTypeBuilder.php", "ContentTypeBuilderPage.php"],
      ["app/Support/ContentTypeBuilder.php", "ContentTypeBuilder.php"],
      ["app/Support/ContentTypeBuilderSchema.php", "ContentTypeBuilderSchema.php"],
      ["app/Support/CamisSchemaSync.php", "CamisSchemaSync.php"],
      ["app/Console/Commands/CamisSchemaSync.php", "CamisSchemaSyncCommand.php"],
      ["config/content-type-builder.php", "content-type-builder.config.php"],
    ] as const) {
      await expect(content(path)).toMatchFileSnapshot(`./__golden__/${golden}`);
    }
  });

  it("is not emitted where Strapi owns the schema or there is no Strapi admin", () => {
    const strapiStorage = filamentAdapter.generate(strapiApiBundle, {
      projectName: "oyl",
      apiStyle: "strapi",
      storageLayout: "strapi",
    });
    const laravel = filamentAdapter.generate(strapiApiBundle, { projectName: "oyl" });
    for (const result of [strapiStorage, laravel]) {
      expect(result.files.map((f) => f.path)).not.toContain(
        "app/Filament/Pages/ContentTypeBuilder.php",
      );
    }
  });
});
