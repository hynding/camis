import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitGeneratedController, emitProtectedController } from "./controller";
import { emitStrapiRoutes } from "./routes";
import { wireShape } from "./wire-shape";

const doc = normalize(strapiApiBundle.document);
const ct = (n: string) => doc.contentTypes.find((c) => c.name === n)!;

describe("strapi-api controllers", () => {
  it("Note generated controller golden (upsert by record_id, owner assign)", async () => {
    await expect(
      emitGeneratedController({
        shape: wireShape(doc, ct("Note"), ["owner_id"]),
        ct: ct("Note"),
        assigns: ["owner"],
        secured: true,
        scoped: true,
      }),
    ).toMatchFileSnapshot("./__golden__/strapi-api/Generated.NoteApiController.php");
  });
  it("Activity generated controller golden (creator assign, or-scope)", async () => {
    await expect(
      emitGeneratedController({
        shape: wireShape(doc, ct("Activity"), ["creator_id"]),
        ct: ct("Activity"),
        assigns: ["creator"],
        secured: true,
        scoped: true,
      }),
    ).toMatchFileSnapshot("./__golden__/strapi-api/Generated.ActivityApiController.php");
  });
  it("protected subclass golden", async () => {
    await expect(emitProtectedController("Note")).toMatchFileSnapshot(
      "./__golden__/strapi-api/NoteApiController.php",
    );
  });
  it("routes golden (kebab plural paths, auth + health, sanctum group)", async () => {
    await expect(
      emitStrapiRoutes(
        doc.contentTypes.filter((c) => c.builtin === undefined),
        true,
      ),
    ).toMatchFileSnapshot("./__golden__/strapi-api/routes.api.php");
  });
  // A failing child insert after `$m->save()` would otherwise leave the parent row persisted
  // with its children already deleted — the delete-then-reinsert in syncChildren is only safe
  // when both halves share one transaction.
  it("wraps save + syncChildren in a single DB transaction in store and both update branches", () => {
    const php = emitGeneratedController({
      shape: wireShape(doc, ct("Note"), ["owner_id"]),
      ct: ct("Note"),
      assigns: ["owner"],
      secured: true,
      scoped: true,
    });
    expect(php).toContain("use Illuminate\\Support\\Facades\\DB;");
    const store = php.slice(
      php.indexOf("public function store"),
      php.indexOf("public function update"),
    );
    const update = php.slice(
      php.indexOf("public function update"),
      php.indexOf("public function destroy"),
    );
    expect(store).toContain("DB::transaction(");
    // both the update branch and the upsert-create branch
    expect(update.match(/DB::transaction\(/g)).toHaveLength(2);
    // every syncChildren call sits inside a transaction closure, never at bare method-body indent
    const syncLines = php.split("\n").filter((l) => l.includes("NoteSerializer::syncChildren("));
    expect(syncLines).toHaveLength(3);
    for (const line of syncLines) expect(line).toMatch(/^ {12,}NoteSerializer::syncChildren\(/);
  });
  it("without upsertBy the key is id and PUT has no create branch", () => {
    const php = emitGeneratedController({
      shape: wireShape(doc, ct("Tag"), []),
      ct: ct("Tag"),
      assigns: [],
      secured: false,
      scoped: false,
    });
    expect(php).toContain("private const KEY = 'id';");
    expect(php).not.toContain("claimed by another scope");
    expect(php).not.toContain("$m->{self::KEY} = $key");
    expect(php).toContain("        abort(404);\n    }");
    expect(php).not.toContain("->forUser(");
  });
});
