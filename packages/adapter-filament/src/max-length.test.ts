import { describe, expect, it } from "vitest";
import type { ContentType, Field } from "@camis/ir-schema";
import { emitApiController } from "./api";
import { emitField } from "./fields";
import { filamentAdapter } from "./generate";
import { stringSizesBundle } from "./__fixtures__/string-sizes";

// Laravel's max rule counts a string's characters with mb_strlen, as the Strapi API style's
// validator counts a maxLength (issue #126).
describe("maxLength enforced on every Filament write path (issue #126)", () => {
  const generate = () => filamentAdapter.generate(stringSizesBundle, { projectName: "docs" });
  const file = (suffix: string) => generate().files.find((f) => f.path.endsWith(suffix))!.content;

  it("checks each bound in the admin form, server side", async () => {
    await expect(file("Schemas/EntryForm.php")).toMatchFileSnapshot(
      "./__golden__/string-sizes/EntryForm.php",
    );
  });

  it.each([
    ["string", "TextInput::make('body')->rule('max:20')"],
    ["email", "TextInput::make('body')->email()->rule('max:20')"],
    ["uid", "TextInput::make('body')->rule('max:20')"],
    ["text", "Textarea::make('body')->rule('max:20')"],
    ["richText", "MarkdownEditor::make('body')->rule('max:20')"],
  ])("bounds a %s's input", (type, input) => {
    expect(emitField({ type, name: "body", maxLength: 20 } as Field).formComponent).toBe(input);
  });

  it("leaves an input without a bound unchecked", () => {
    expect(emitField({ type: "text", name: "body" } as Field).formComponent).toBe(
      "Textarea::make('body')",
    );
  });

  it("checks each bound in the Laravel API style's create and update", async () => {
    await expect(file("Api/EntryApiController.php")).toMatchFileSnapshot(
      "./__golden__/string-sizes/EntryApiController.php",
    );
  });

  it("checks a bound after authorizing, on a secured API", () => {
    const note = {
      name: "Note",
      kind: "collection",
      fields: [{ type: "string", name: "title", maxLength: 20 }],
    } as ContentType;
    const php = emitApiController(note, ["title"], {
      secured: true,
      lengths: [{ column: "title", maxLength: 20 }],
    });
    expect(php).toContain(
      "        $this->authorize('create', Note::class);\n        $request->validate(self::RULES);\n",
    );
    expect(php).toContain(
      "        $this->authorize('update', $note);\n        $request->validate(self::RULES);\n",
    );
  });

  it("checks nothing where no field is bounded", () => {
    const note = { name: "Note", kind: "collection", fields: [] } as unknown as ContentType;
    const php = emitApiController(note, [], { secured: false });
    expect(php).not.toContain("RULES");
  });

  it("regenerates byte for byte", () => {
    expect(file("Api/EntryApiController.php")).toBe(file("Api/EntryApiController.php"));
  });
});
