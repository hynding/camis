import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi's color-picker plugin registers a custom field whose value is a string ("#rrggbb"):
// a running Strapi holds it as a string attribute, so its API, documents and validation treat it
// as one, and its admin edits it with a color input.
const HEX = "^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$";
const bundle: IrBundle = {
  ...strapiApiBundle,
  document: {
    ...strapiApiBundle.document,
    contentTypes: [
      ...strapiApiBundle.document.contentTypes,
      {
        name: "Swatch",
        kind: "collection",
        fields: [
          { type: "string", name: "label" },
          { type: "color", name: "accentColor", names: { api: "accent_color" }, pattern: HEX },
        ],
      },
    ],
  },
};
const result = filamentAdapter.generate(bundle, {
  projectName: "oyl",
  apiStyle: "strapi",
  documentation: true,
  graphql: true,
});
const content = (p: string) => result.files.find((f) => f.path.endsWith(p))?.content ?? "";

describe("a color field on the Strapi API style", () => {
  it("is validated as Strapi validates a string, its regex included", () => {
    expect(content("app/Http/Controllers/Api/Generated/SwatchApiController.php")).toContain(
      `'accent_color' => ['type' => 'string', 'regex' => '${HEX}'],`,
    );
  });

  it("is documented as a string field", () => {
    const document = JSON.stringify(JSON.parse(content("public/documentation/openapi.json")));
    expect(document).toContain('"accent_color":{"description":"A string field","type":"string"}');
    expect(document).not.toContain("A color field");
  });

  it("is a String in GraphQL", () => {
    const schema = content("graphql/schema.graphql");
    expect(schema).toMatch(/type Swatch \{[^}]*accent_color: String\n/);
  });

  it("is searched and sorted in the Content Manager list, and shown as a swatch", () => {
    const table = content("app/Filament/Resources/Swatches/Schemas/SwatchesTable.php");
    expect(table).toContain("ColorColumn::make('accent_color')->searchable()->sortable()");
  });

  it("is edited with a color picker", () => {
    expect(content("app/Filament/Resources/Swatches/Schemas/SwatchForm.php")).toContain(
      `ColorPicker::make('accent_color')->regex('~${HEX}~')`,
    );
  });

  it("is no capability gap", () => {
    expect(result.gaps.gaps.filter((g) => g.location.contentType === "Swatch")).toEqual([]);
  });
});
