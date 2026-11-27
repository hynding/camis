import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { characterCountVectors } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";
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
      `router.post("/", asyncRoute(async (req, res) => {\n${CHECK}`.replace(
        "router",
        "entriesRouter",
      ),
    );
    expect(ts).toContain(
      `router.patch("/:id(\\\\d+)", asyncRoute(async (req, res) => {\n${CHECK}`.replace(
        "router",
        "entriesRouter",
      ),
    );
  });

  // On a secured API the check runs on what the caller may write: after the record condition
  // refuses a row the role could not have written (403), and after the field rules strip what it
  // may not write, so a stripped field past its bound is no 400.
  it("checks each bound on the permitted body, after the record condition, on a secured API", () => {
    const ts = emitRoutes(entry, [], { secured: true });
    const checkData = CHECK.replace("tooLong(req.body,", "tooLong(data,");
    const forbidden = `    res.status(403).json({ error: "forbidden" });\n    return;\n  }\n`;
    expect(ts).toContain(
      `  if (!recordAllowed(req, "Entry", "create", data)) {\n${forbidden}${checkData}\n  const [{ id }] = await db.insert(`,
    );
    expect(ts).toContain(
      `  if (!recordAllowed(req, "Entry", "update", { ...existing, ...data })) {\n${forbidden}${checkData}\n  if (Object.keys(data).length > 0)\n`,
    );
    expect(ts).not.toContain(CHECK);
  });

  // A value the column cannot hold is refused as invalid (400) rather than failing in the database.
  it.each([
    ["sqlite", 1000],
    ["mysql", 673],
    ["pgsql", 673],
  ] as const)("checks the length a unique column holds on %s", (dialect, length) => {
    const handle = {
      name: "Entry",
      kind: "collection",
      fields: [{ type: "string", name: "handle", unique: true, maxLength: 1000 }],
    } as ContentType;
    expect(emitRoutes(handle, [], { dialect })).toContain(
      `const MAX_LENGTHS: Record<string, number> = { handle: ${length} };`,
    );
  });

  // A unique text keeps its text column, which no index caps (issue #126).
  it.each(["sqlite", "mysql", "pgsql"] as const)(
    "checks a unique text at its bound on %s",
    (dialect) => {
      const notes = {
        name: "Entry",
        kind: "collection",
        fields: [
          { type: "text", name: "body", unique: true, maxLength: 1000 },
          { type: "richText", name: "notes", unique: true, maxLength: 2000 },
        ],
      } as ContentType;
      expect(emitRoutes(notes, [], { dialect })).toContain(
        "const MAX_LENGTHS: Record<string, number> = { body: 1000, notes: 2000 };",
      );
    },
  );

  it("emits the check and the routers that run it as golden files that parse", async () => {
    const files = expressAdapterFor("sqlite").generate(bundle, { projectName: "docs" }).files;
    const content = (path: string) => files.find((f) => f.path === path)!.content;
    await expect(content("src/lengths.ts")).toMatchFileSnapshot(
      "./__golden__/lengths/lengths.ts.txt",
    );
    await expect(content("src/routes/entries.ts")).toMatchFileSnapshot(
      "./__golden__/lengths/entries.routes.ts.txt",
    );
    for (const path of ["src/lengths.ts", "src/routes/entries.ts"]) {
      const out = ts.transpileModule(content(path), { fileName: path, reportDiagnostics: true });
      expect(out.diagnostics ?? []).toEqual([]);
    }
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
