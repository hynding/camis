import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";

// A json field holds any JSON value, as Strapi's does; the admin edits it as JSON text through
// JsonText, which must give back on save exactly the value it was shown.
const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const bundle = (fields: IrBundle["document"]["contentTypes"][number]["fields"]): IrBundle => ({
  document: {
    version: 1,
    contentTypes: [{ name: "Article", kind: "collection", fields }],
    components: [],
  },
  roles: [],
});

const RUNTIME = ["app/Support/JsonText.php", "app/Filament/Forms/JsonEditor.php"];

describe("json fields on the Filament target", () => {
  const withJson = filamentAdapter.generate(bundle([{ type: "json", name: "meta" }]), {
    projectName: "blog",
  });
  const content = (path: string): string =>
    withJson.files.find((f) => f.path === path)?.content ?? "";

  it("generates the JSON editor only for a project with a json field", () => {
    const paths = withJson.files.map((f) => f.path);
    for (const p of RUNTIME) expect(paths).toContain(p);
    const without = filamentAdapter.generate(bundle([{ type: "string", name: "title" }]), {
      projectName: "blog",
    });
    for (const p of RUNTIME) expect(without.files.map((f) => f.path)).not.toContain(p);
  });

  it("shows the stored JSON itself, so an empty object stays an object", () => {
    const editor = content("app/Filament/Forms/JsonEditor.php");
    expect(editor).toContain("class JsonEditor extends Textarea");
    expect(editor).toContain("getRawOriginal(");
    expect(editor).toContain("JsonText::toText(");
    expect(editor).toContain("JsonText::fromText(");
    expect(editor).toContain("json_validate(");
  });

  describe.skipIf(!hasPhp())("JsonText, run by PHP", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "camis-json-"));
      writeFileSync(join(dir, "JsonText.php"), content("app/Support/JsonText.php"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    /** Each stored JSON text as the editor shows it, then as saving it stores it again. */
    const roundTrip = (stored: string[]): { shown: string | null; saved: string }[] => {
      const input = join(dir, "stored.json");
      writeFileSync(input, JSON.stringify(stored));
      const script = `require '${dir}/JsonText.php';
        $out = [];
        foreach (json_decode(file_get_contents('${input}'), true) as $json) {
          $shown = App\\Support\\JsonText::toText(json_decode($json));
          $out[] = ['shown' => $shown, 'saved' => json_encode(App\\Support\\JsonText::fromText($shown), JSON_PRESERVE_ZERO_FRACTION | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)];
        }
        echo json_encode($out);`;
      return JSON.parse(execFileSync("php", ["-r", script], { encoding: "utf8" })) as {
        shown: string | null;
        saved: string;
      }[];
    };

    it("saves back every value it shows, nested, listed, numeric or boolean", () => {
      const stored = [
        '{"a":{"b":[1,2.5,{"c":true}]},"d":null,"e":"x/y é"}',
        '[1,"two",false]',
        "{}",
        '{"empty":{},"list":[]}',
        "42",
        '"text"',
        "true",
      ];
      const results = roundTrip(stored);
      stored.forEach((json, i) => expect(results[i]!.saved, json).toBe(json));
      expect(results[0]!.shown).toBe(
        '{\n    "a": {\n        "b": [\n            1,\n            2.5,\n            {\n                "c": true\n            }\n        ]\n    },\n    "d": null,\n    "e": "x/y é"\n}',
      );
    });

    it("stores no value for blank text, and no text for no value", () => {
      const script = `require '${dir}/JsonText.php';
        var_export([App\\Support\\JsonText::fromText('  '), App\\Support\\JsonText::fromText(null), App\\Support\\JsonText::toText(null)]);`;
      expect(execFileSync("php", ["-r", script], { encoding: "utf8" })).toBe(
        "array (\n  0 => NULL,\n  1 => NULL,\n  2 => NULL,\n)",
      );
    });
  });
});
