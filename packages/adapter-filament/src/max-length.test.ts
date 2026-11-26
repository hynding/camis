import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { characterCountVectors } from "@camis/adapter-kernel";
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

  // A value the column cannot hold is refused as invalid (400) rather than failing in the database.
  it.each([
    ["laravel", 673, 1000, 20000, 320],
    ["strapi", 255, 255, 255, 255],
  ] as const)(
    "checks the length the column holds in the Strapi API style on the %s storage layout",
    (storageLayout, handle, headline, abstract, contact) => {
      const php = filamentAdapter
        .generate(stringSizesBundle, { projectName: "docs", apiStyle: "strapi", storageLayout })
        .files.find((f) => f.path.endsWith("Generated/EntryApiController.php"))!.content;
      expect(php).toContain(`'code' => ['type' => 'string', 'maxLength' => 40],`);
      expect(php).toContain(`'headline' => ['type' => 'string', 'maxLength' => ${headline}],`);
      expect(php).toContain(`'abstract' => ['type' => 'string', 'maxLength' => ${abstract}],`);
      expect(php).toContain(`'contact' => ['type' => 'email', 'maxLength' => ${contact}],`);
      expect(php).toContain(
        `'handle' => ['type' => 'string', 'maxLength' => ${handle}, 'unique' => ['column' => 'handle']],`,
      );
    },
  );

  it("regenerates byte for byte", () => {
    expect(file("Api/EntryApiController.php")).toBe(file("Api/EntryApiController.php"));
  });
});

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// Laravel's max rule (Validator::getSize) and StrapiValidator both count with mb_strlen; the
// Express target counts the same vectors (adapter-express max-length.test.ts).
describe.skipIf(!hasPhp())("mb_strlen counts the conformance vectors' characters", () => {
  it("as each vector states", () => {
    const counted = execFileSync(
      "php",
      [
        "-r",
        "echo json_encode(array_map('mb_strlen', json_decode(stream_get_contents(STDIN), true)));",
      ],
      { input: JSON.stringify(characterCountVectors.map((v) => v.value)) },
    ).toString();
    expect(JSON.parse(counted)).toEqual(characterCountVectors.map((v) => v.characters));
  });
});
