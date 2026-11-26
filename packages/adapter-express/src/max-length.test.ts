import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { characterCountVectors } from "@camis/adapter-kernel";
import type { ContentType, IrBundle } from "@camis/ir-schema";
import { expressAdapterFor } from "./generate";
import { emitRoutes } from "./routes";

const entry = {
  name: "Entry",
  kind: "collection",
  fields: [
    { type: "string", name: "title" },
    { type: "string", name: "code", maxLength: 40 },
    { type: "text", name: "body", maxLength: 1000 },
    { type: "richText", name: "notes", maxLength: 2000 },
    { type: "email", name: "contact", maxLength: 320 },
    { type: "uid", name: "slug", maxLength: 300 },
  ],
} as ContentType;

const bundle = {
  document: { version: 1, contentTypes: [entry], components: [] },
  roles: [],
} as unknown as IrBundle;

const BOUNDS =
  "const MAX_LENGTHS: Record<string, number> = { code: 40, body: 1000, notes: 2000, contact: 320, slug: 300 };";
const CHECK = `  const longer = tooLong(req.body, MAX_LENGTHS);
  if (longer !== null) {
    res.status(400).json({ error: longer });
    return;
  }`;

// The Express API refuses a value longer than its bound, counted in characters as PHP's mb_strlen
// counts them (the Filament target's Laravel max rule and Strapi API style validator), not in the
// UTF-16 code units a JavaScript string's length counts (issue #126).
describe("Express target: maxLength enforced in the API (issue #126)", () => {
  it("checks each bound on create and update", () => {
    const ts = emitRoutes(entry, []);
    expect(ts).toContain('import { tooLong } from "../lengths";');
    expect(ts).toContain(BOUNDS);
    expect(ts).toContain(
      `router.post("/", (req, res) => {\n${CHECK}`.replace("router", "entriesRouter"),
    );
    expect(ts).toContain(
      `router.patch("/:id", (req, res) => {\n${CHECK}`.replace("router", "entriesRouter"),
    );
  });

  it("checks each bound after authorizing, on a secured API", () => {
    const ts = emitRoutes(entry, [], { secured: true });
    expect(ts).toContain(
      `authorizeAction(roleOf(req), "Entry", "create")) {\n    res.status(403).json({ error: "forbidden" });\n    return;\n  }\n${CHECK}`,
    );
    expect(ts).toContain(
      `authorizeAction(roleOf(req), "Entry", "update")) {\n    res.status(403).json({ error: "forbidden" });\n    return;\n  }\n${CHECK}`,
    );
  });

  it("checks nothing where no field is bounded", () => {
    const ts = emitRoutes(
      { ...entry, fields: [{ type: "string", name: "title" }] } as ContentType,
      [],
    );
    expect(ts).not.toContain("tooLong");
    expect(
      expressAdapterFor("sqlite")
        .generate(
          { ...bundle, document: { ...bundle.document, contentTypes: [] } },
          { projectName: "x" },
        )
        .files.some((f) => f.path === "src/lengths.ts"),
    ).toBe(false);
  });

  describe("the generated check", () => {
    const dir = mkdtempSync(join(tmpdir(), "camis-lengths-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const load = async () => {
      const file = expressAdapterFor("sqlite")
        .generate(bundle, { projectName: "docs" })
        .files.find((f) => f.path === "src/lengths.ts");
      expect(file).toBeDefined();
      const path = join(dir, "lengths.ts");
      writeFileSync(path, file!.content);
      return (await import(pathToFileURL(path).href)) as {
        characterCount: (value: string) => number;
        tooLong: (body: Record<string, unknown>, bounds: Record<string, number>) => string | null;
      };
    };

    it("counts each conformance vector's characters", async () => {
      const { characterCount } = await load();
      for (const { value, characters } of characterCountVectors)
        expect(characterCount(value), JSON.stringify(value)).toBe(characters);
    });

    it("takes a value of four-byte characters at its bound and refuses one past it", async () => {
      const { tooLong } = await load();
      const emoji = (n: number) => "\u{1F600}".repeat(n);
      expect(tooLong({ code: emoji(40) }, { code: 40 })).toBeNull();
      expect(tooLong({ code: emoji(41) }, { code: 40 })).toBe("code must be at most 40 characters");
      expect(tooLong({ code: null, title: emoji(500) }, { code: 40 })).toBeNull();
    });
  });
});
