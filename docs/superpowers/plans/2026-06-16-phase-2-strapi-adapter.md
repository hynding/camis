# Phase 2 — Strapi Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile a validated IR document into a runnable Strapi v5 project for an `Article` (+ `Author`) collection type via `@camis/adapter-kernel` (codegen contract, marker/manifest, deterministic `materialize`) and `@camis/adapter-strapi` (the Strapi mapping).

**Architecture:** Adapters are pure — `generate(doc) → GenerationResult` (in-memory files + manifest + capability gaps), no disk I/O. The kernel's async `materialize(result, destDir)` writes to disk idempotently with three file modes (`overwrite`, `seed`, protected). `adapter-strapi` normalizes the doc (ir-core), projects Strapi names, maps fields (target-specific casing confined here), and emits a from-scratch skeleton (captured once from a real Strapi v5 scaffold) plus IR-derived `schema.json` + factory controllers/routes/services. Output lands in git-ignored `generated/`.

**Tech Stack:** TypeScript (strict, ESM, `moduleResolution: Bundler`, extensionless relative imports, `import type`), Vitest (incl. `toMatchFileSnapshot` for goldens), Node `fs/promises` + `crypto`. Strapi v5 (pinned exact version).

**Reference:** `docs/superpowers/specs/2026-06-16-phase-2-strapi-adapter-design.md` (decisions D1–D12). Phase 1 packages `@camis/ir-schema` (types `IrDocument`, `ContentType`, `Field`, `CapabilityGapReport`, `CapabilityGap`) and `@camis/ir-core` (`validate`, `normalize`) are complete.

**Conventions:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. `import type` for type-only imports. Relative imports extensionless. Run a single test file with `pnpm --filter @camis/<pkg> exec vitest run src/<file>.test.ts`.

---

## File structure

**`packages/adapter-kernel/src/`**
- `types.ts` — `FileMode`, `GeneratedFile`, `ManifestEntry`, `Manifest`, `GenerateOptions`, `GenerationResult`, `GenerateAdapter`.
- `stable-json.ts` — `stableJson` (insertion-order-preserving, 2-space, trailing newline).
- `marker.ts` — `TS_MARKER`, `withMarker`.
- `manifest.ts` — `MANIFEST_PATH`, `sha256`, `buildManifest`.
- `materialize.ts` — async `materialize(result, destDir)`.
- `index.ts` — public surface.

**`packages/adapter-strapi/src/`**
- `names.ts` — `StrapiNames`, `strapiNames(ct)`.
- `attributes.ts` — `toAttribute(field)` + `toAttributes(fields)` (field→Strapi mapping, casing, relations).
- `schema.ts` — `contentTypeSchema(ct)` → the schema.json object.
- `api-files.ts` — factory controller/route/service file contents for a type.
- `skeleton/` — captured static templates + `skeletonFiles(projectName)`.
- `generate.ts` — `strapiAdapter: GenerateAdapter`.
- `__fixtures__/blog.ts` — Article + Author IR fixture.
- `__golden__/` — committed snapshot files (excluded from formatters).
- `index.ts` — public surface.

---

## Task 1: adapter-kernel types

**Files:**
- Modify: `packages/adapter-kernel/package.json` (add `@camis/ir-schema` workspace dep)
- Create: `packages/adapter-kernel/src/types.ts`
- Test: `packages/adapter-kernel/src/types.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @camis/adapter-kernel add @camis/ir-schema@workspace:*`

- [ ] **Step 2: Write the failing test**

`packages/adapter-kernel/src/types.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { GenerateAdapter, GeneratedFile, GenerationResult } from "./types";

describe("kernel types", () => {
  it("a GeneratedFile and a minimal adapter are well-typed", () => {
    const file: GeneratedFile = { path: "src/x.ts", content: "x" };
    const adapter: GenerateAdapter = {
      target: "noop",
      generate: (): GenerationResult => ({
        files: [file],
        manifest: { generator: "camis", files: [] },
        gaps: { target: "noop", gaps: [] },
      }),
    };
    expect(adapter.target).toBe("noop");
    expect(file.mode).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/types.test.ts`
Expected: FAIL — cannot resolve `./types`.

- [ ] **Step 4: Write the implementation**

`packages/adapter-kernel/src/types.ts`
```ts
import type { CapabilityGapReport, IrDocument } from "@camis/ir-schema";

export type FileMode = "overwrite" | "seed";

export interface GeneratedFile {
  path: string; // relative to project root, POSIX separators
  content: string;
  mode?: FileMode; // default "overwrite"
}

export interface ManifestEntry {
  path: string;
  mode: FileMode;
  sha256: string;
}

export interface Manifest {
  generator: string;
  files: ManifestEntry[];
}

export interface GenerateOptions {
  projectName: string;
}

export interface GenerationResult {
  files: GeneratedFile[];
  manifest: Manifest;
  gaps: CapabilityGapReport;
}

export interface GenerateAdapter {
  target: string;
  generate(doc: IrDocument, options: GenerateOptions): GenerationResult;
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/types.test.ts`
Run: `pnpm --filter @camis/adapter-kernel typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-kernel pnpm-lock.yaml
git commit -m "feat(adapter-kernel): codegen contract types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: stableJson

**Files:**
- Create: `packages/adapter-kernel/src/stable-json.ts`
- Test: `packages/adapter-kernel/src/stable-json.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapter-kernel/src/stable-json.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { stableJson } from "./stable-json";

describe("stableJson", () => {
  it("preserves insertion order (does not sort keys)", () => {
    expect(stableJson({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}\n');
  });

  it("2-space indents nested objects and ends with a newline", () => {
    expect(stableJson({ x: { y: 1 } })).toBe('{\n  "x": {\n    "y": 1\n  }\n}\n');
  });

  it("is deterministic for the same input", () => {
    const v = { type: "string", required: true };
    expect(stableJson(v)).toBe(stableJson(v));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/stable-json.test.ts`
Expected: FAIL — cannot resolve `./stable-json`.

- [ ] **Step 3: Implement**

`packages/adapter-kernel/src/stable-json.ts`
```ts
// Deterministic JSON: 2-space indent, trailing newline, INSERTION order preserved
// (JSON.stringify preserves key insertion order; we deliberately do not sort).
export const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/stable-json.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-kernel
git commit -m "feat(adapter-kernel): deterministic stableJson

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: marker header

**Files:**
- Create: `packages/adapter-kernel/src/marker.ts`
- Test: `packages/adapter-kernel/src/marker.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapter-kernel/src/marker.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { TS_MARKER, withMarker } from "./marker";

describe("marker", () => {
  it("prefixes content with the generated marker on its own line", () => {
    expect(withMarker("export default 1;")).toBe(`${TS_MARKER}\nexport default 1;`);
  });

  it("marker identifies generated files", () => {
    expect(TS_MARKER).toContain("@camis:generated");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/marker.test.ts`
Expected: FAIL — cannot resolve `./marker`.

- [ ] **Step 3: Implement**

`packages/adapter-kernel/src/marker.ts`
```ts
export const TS_MARKER = "// @camis:generated — do not edit; regenerated by camis";

export const withMarker = (content: string): string => `${TS_MARKER}\n${content}`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/marker.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-kernel
git commit -m "feat(adapter-kernel): generated-file marker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: manifest

**Files:**
- Create: `packages/adapter-kernel/src/manifest.ts`
- Test: `packages/adapter-kernel/src/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapter-kernel/src/manifest.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { buildManifest, MANIFEST_PATH, sha256 } from "./manifest";
import type { GeneratedFile } from "./types";

describe("manifest", () => {
  it("hashes content with sha256", () => {
    expect(sha256("x")).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });

  it("lists files sorted by path with mode and hash, excluding the manifest itself", () => {
    const files: GeneratedFile[] = [
      { path: "b.txt", content: "b" },
      { path: "a.txt", content: "a", mode: "seed" },
      { path: MANIFEST_PATH, content: "ignored" },
    ];
    const m = buildManifest(files);
    expect(m.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(m.files[0]).toMatchObject({ path: "a.txt", mode: "seed" });
    expect(m.files[1]).toMatchObject({ path: "b.txt", mode: "overwrite" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/manifest.test.ts`
Expected: FAIL — cannot resolve `./manifest`.

- [ ] **Step 3: Implement**

`packages/adapter-kernel/src/manifest.ts`
```ts
import { createHash } from "node:crypto";
import type { GeneratedFile, Manifest, ManifestEntry } from "./types";

export const MANIFEST_PATH = ".camis/manifest.json";

export const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

export const buildManifest = (files: GeneratedFile[]): Manifest => ({
  generator: "camis",
  files: files
    .filter((f) => f.path !== MANIFEST_PATH)
    .map((f): ManifestEntry => ({ path: f.path, mode: f.mode ?? "overwrite", sha256: sha256(f.content) }))
    .sort((a, b) => a.path.localeCompare(b.path)),
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/manifest.test.ts`
Expected: PASS (2 tests). (If the sha256 literal differs, replace it with the actual digest the test prints.)

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-kernel
git commit -m "feat(adapter-kernel): manifest builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: materialize (overwrite + protected + delete-dropped)

**Files:**
- Create: `packages/adapter-kernel/src/materialize.ts`
- Test: `packages/adapter-kernel/src/materialize.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapter-kernel/src/materialize.test.ts`
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "./manifest";
import { materialize } from "./materialize";
import type { GenerationResult } from "./types";

const result = (files: GenerationResult["files"]): GenerationResult => ({
  files,
  manifest: buildManifest(files),
  gaps: { target: "t", gaps: [] },
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "camis-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("materialize", () => {
  it("writes overwrite files and the manifest", async () => {
    await materialize(result([{ path: "src/a.ts", content: "A" }]), dir);
    expect(await readFile(join(dir, "src/a.ts"), "utf8")).toBe("A");
    expect(existsSync(join(dir, ".camis/manifest.json"))).toBe(true);
  });

  it("leaves a protected (unmanaged) file untouched across regen", async () => {
    await materialize(result([{ path: "src/a.ts", content: "A" }]), dir);
    await writeFile(join(dir, "hand.ts"), "MINE");
    await materialize(result([{ path: "src/a.ts", content: "A2" }]), dir);
    expect(await readFile(join(dir, "hand.ts"), "utf8")).toBe("MINE");
    expect(await readFile(join(dir, "src/a.ts"), "utf8")).toBe("A2");
  });

  it("deletes an overwrite file dropped from the new manifest", async () => {
    await materialize(result([{ path: "a.ts", content: "A" }, { path: "b.ts", content: "B" }]), dir);
    await materialize(result([{ path: "a.ts", content: "A" }]), dir);
    expect(existsSync(join(dir, "b.ts"))).toBe(false);
    expect(existsSync(join(dir, "a.ts"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/materialize.test.ts`
Expected: FAIL — cannot resolve `./materialize`.

- [ ] **Step 3: Implement**

`packages/adapter-kernel/src/materialize.ts`
```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MANIFEST_PATH } from "./manifest";
import { stableJson } from "./stable-json";
import type { GenerationResult, Manifest } from "./types";

export const materialize = async (result: GenerationResult, destDir: string): Promise<void> => {
  const manifestAbs = join(destDir, MANIFEST_PATH);
  let prior: Manifest | undefined;
  if (existsSync(manifestAbs)) {
    prior = JSON.parse(await readFile(manifestAbs, "utf8")) as Manifest;
  }

  const newPaths = new Set(result.files.map((f) => f.path));
  if (prior) {
    for (const entry of prior.files) {
      if (entry.mode === "overwrite" && !newPaths.has(entry.path)) {
        await rm(join(destDir, entry.path), { force: true });
      }
    }
  }

  for (const file of result.files) {
    const abs = join(destDir, file.path);
    if ((file.mode ?? "overwrite") === "seed" && existsSync(abs)) continue;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
  }

  await mkdir(dirname(manifestAbs), { recursive: true });
  await writeFile(manifestAbs, stableJson(result.manifest), "utf8");
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/materialize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-kernel
git commit -m "feat(adapter-kernel): materialize with manifest-driven cleanup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: materialize seed mode + kernel public surface

**Files:**
- Modify: `packages/adapter-kernel/src/materialize.test.ts` (append)
- Create: `packages/adapter-kernel/src/index.ts`
- Test: `packages/adapter-kernel/src/index.test.ts`

- [ ] **Step 1: Append the seed-mode test**

Append to `packages/adapter-kernel/src/materialize.test.ts`:
```ts
describe("materialize seed mode", () => {
  it("writes a seed file when absent but never overwrites a user-modified one", async () => {
    await materialize(result([{ path: ".env", content: "ORIGINAL", mode: "seed" }]), dir);
    await writeFile(join(dir, ".env"), "USER_EDITED");
    await materialize(result([{ path: ".env", content: "ORIGINAL", mode: "seed" }]), dir);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("USER_EDITED");
  });
});
```

- [ ] **Step 2: Run to verify it passes (seed logic already implemented in Task 5)**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/materialize.test.ts`
Expected: PASS (4 tests). If the new test fails, the seed guard in `materialize.ts` is wrong — fix it (`mode === "seed" && existsSync(abs) → continue`).

- [ ] **Step 3: Write the public surface test**

`packages/adapter-kernel/src/index.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { buildManifest, MANIFEST_PATH, materialize, stableJson, withMarker } from "./index";

describe("kernel public surface", () => {
  it("exports the codegen toolkit", () => {
    expect(typeof materialize).toBe("function");
    expect(typeof buildManifest).toBe("function");
    expect(typeof stableJson).toBe("function");
    expect(typeof withMarker).toBe("function");
    expect(MANIFEST_PATH).toBe(".camis/manifest.json");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run src/index.test.ts`
Expected: FAIL — exports missing from stub `index.ts`.

- [ ] **Step 5: Implement the public surface**

`packages/adapter-kernel/src/index.ts` (replace the stub entirely)
```ts
export type {
  FileMode,
  GeneratedFile,
  GenerateAdapter,
  GenerateOptions,
  GenerationResult,
  Manifest,
  ManifestEntry,
} from "./types";
export { stableJson } from "./stable-json";
export { TS_MARKER, withMarker } from "./marker";
export { buildManifest, MANIFEST_PATH, sha256 } from "./manifest";
export { materialize } from "./materialize";
```

- [ ] **Step 6: Run test + typecheck + full kernel suite**

Run: `pnpm --filter @camis/adapter-kernel exec vitest run`
Run: `pnpm --filter @camis/adapter-kernel typecheck`
Expected: all PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-kernel
git commit -m "feat(adapter-kernel): seed-mode test and public surface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: adapter-strapi name projection

**Files:**
- Modify: `packages/adapter-strapi/package.json` (add deps)
- Create: `packages/adapter-strapi/src/names.ts`
- Test: `packages/adapter-strapi/src/names.test.ts`

- [ ] **Step 1: Add dependencies**

Run: `pnpm --filter @camis/adapter-strapi add @camis/adapter-kernel@workspace:* @camis/ir-schema@workspace:* @camis/ir-core@workspace:*`

- [ ] **Step 2: Write the failing test**

`packages/adapter-strapi/src/names.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { strapiNames } from "./names";

const ct = (name: string, names?: ContentType["names"]): ContentType => ({
  name,
  kind: "collection",
  fields: [],
  ...(names ? { names } : {}),
});

describe("strapiNames", () => {
  it("projects a single-word PascalCase name", () => {
    expect(strapiNames(ct("Article", { plural: "Articles", display: "Article", collection: "articles" }))).toEqual({
      singularName: "article",
      pluralName: "articles",
      collectionName: "articles",
      displayName: "Article",
      uid: "api::article.article",
    });
  });

  it("kebab-cases multi-word names", () => {
    const n = strapiNames(ct("BlogPost", { plural: "BlogPosts", display: "Blog Post", collection: "blog_posts" }));
    expect(n.singularName).toBe("blog-post");
    expect(n.pluralName).toBe("blog-posts");
    expect(n.uid).toBe("api::blog-post.blog-post");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/names.test.ts`
Expected: FAIL — cannot resolve `./names`.

- [ ] **Step 4: Implement**

`packages/adapter-strapi/src/names.ts`
```ts
import type { ContentType } from "@camis/ir-schema";

export interface StrapiNames {
  singularName: string;
  pluralName: string;
  collectionName: string;
  displayName: string;
  uid: string;
}

const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

// Assumes a normalized ContentType (names.* populated by ir-core); falls back to the
// canonical name if an override is missing.
export const strapiNames = (ct: ContentType): StrapiNames => {
  const singularName = kebab(ct.name);
  const pluralName = kebab(ct.names?.plural ?? ct.name);
  return {
    singularName,
    pluralName,
    collectionName: ct.names?.collection ?? pluralName,
    displayName: ct.names?.display ?? ct.name,
    uid: `api::${singularName}.${singularName}`,
  };
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/names.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-strapi pnpm-lock.yaml
git commit -m "feat(adapter-strapi): Strapi name projection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: attribute mapping — scalars + constraints

**Files:**
- Create: `packages/adapter-strapi/src/attributes.ts`
- Test: `packages/adapter-strapi/src/attributes.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapter-strapi/src/attributes.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { toAttribute } from "./attributes";

describe("toAttribute — scalars", () => {
  it("maps a string with constraints", () => {
    const f: Field = { type: "string", name: "title", required: true, maxLength: 200 };
    expect(toAttribute(f)).toEqual({ type: "string", required: true, maxLength: 200 });
  });

  it("lowercases richText/bigInteger/dateTime to Strapi casing", () => {
    expect(toAttribute({ type: "richText", name: "body" })).toEqual({ type: "richtext" });
    expect(toAttribute({ type: "bigInteger", name: "n" })).toEqual({ type: "biginteger" });
    expect(toAttribute({ type: "dateTime", name: "at" })).toEqual({ type: "datetime" });
  });

  it("maps enumeration values to enum", () => {
    expect(toAttribute({ type: "enumeration", name: "status", values: ["draft", "live"], default: "draft" }))
      .toEqual({ type: "enumeration", enum: ["draft", "live"], default: "draft" });
  });

  it("omits absent constraints (no undefined keys)", () => {
    expect(toAttribute({ type: "boolean", name: "flag" })).toEqual({ type: "boolean" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/attributes.test.ts`
Expected: FAIL — cannot resolve `./attributes`.

- [ ] **Step 3: Implement (scalars half; relations added in Task 9)**

`packages/adapter-strapi/src/attributes.ts`
```ts
import type { Field } from "@camis/ir-schema";

type Attribute = Record<string, unknown>;

const TYPE_MAP: Record<string, string> = {
  richText: "richtext",
  bigInteger: "biginteger",
  dateTime: "datetime",
  dynamicZone: "dynamiczone",
};

// Copy a key onto the attribute only when defined (no `undefined` keys → stable JSON).
const put = (attr: Attribute, key: string, value: unknown): void => {
  if (value !== undefined) attr[key] = value;
};

export const toAttribute = (field: Field): Attribute => {
  const f = field as Field & Record<string, unknown>;
  const attr: Attribute = { type: TYPE_MAP[field.type] ?? field.type };

  if (field.type === "enumeration") {
    attr.enum = field.values;
    put(attr, "default", field.default);
    put(attr, "required", f.required);
    return attr;
  }

  put(attr, "required", f.required);
  put(attr, "unique", f.unique);
  put(attr, "minLength", f.minLength);
  put(attr, "maxLength", f.maxLength);
  put(attr, "min", f.min);
  put(attr, "max", f.max);
  put(attr, "default", f.default);
  return attr;
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/attributes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): scalar attribute mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: attribute mapping — relations + toAttributes

**Files:**
- Modify: `packages/adapter-strapi/src/attributes.ts`
- Test: `packages/adapter-strapi/src/attributes.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

Append to `packages/adapter-strapi/src/attributes.test.ts`:
```ts
import { toAttributes } from "./attributes";

describe("toAttribute — relations", () => {
  it("maps a relation with an inverse to the api:: target uid + inversedBy", () => {
    expect(toAttribute({ type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" }))
      .toEqual({ type: "relation", relation: "manyToOne", target: "api::author.author", inversedBy: "articles" });
  });

  it("omits inversedBy for a unidirectional relation", () => {
    expect(toAttribute({ type: "relation", name: "owner", relationKind: "oneToOne", target: "User" }))
      .toEqual({ type: "relation", relation: "oneToOne", target: "api::user.user" });
  });
});

describe("toAttributes", () => {
  it("builds an ordered attributes object keyed by field name", () => {
    const attrs = toAttributes([
      { type: "string", name: "title" },
      { type: "boolean", name: "flag" },
    ]);
    expect(Object.keys(attrs)).toEqual(["title", "flag"]);
    expect(attrs.title).toEqual({ type: "string" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/attributes.test.ts`
Expected: FAIL — relation branch missing; `toAttributes` not exported.

- [ ] **Step 3: Update implementation**

In `packages/adapter-strapi/src/attributes.ts`, add a relation branch inside `toAttribute` (before the generic constraint block) and add `toAttributes`. Add this relation handling right after the `enumeration` block:
```ts
  if (field.type === "relation") {
    const targetSingular = field.target.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    attr.relation = field.relationKind;
    attr.target = `api::${targetSingular}.${targetSingular}`;
    put(attr, "inversedBy", field.inverse);
    return attr;
  }
```
And at the end of the file:
```ts
export const toAttributes = (fields: Field[]): Record<string, Attribute> => {
  const out: Record<string, Attribute> = {};
  for (const field of fields) out[field.name] = toAttribute(field);
  return out;
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/attributes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): relation attribute mapping and toAttributes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: content-type schema.json builder

**Files:**
- Create: `packages/adapter-strapi/src/schema.ts`
- Test: `packages/adapter-strapi/src/schema.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapter-strapi/src/schema.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { contentTypeSchema } from "./schema";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  names: { plural: "Articles", display: "Article", collection: "articles" },
  fields: [{ type: "string", name: "title", required: true }],
  options: { draftPublish: true },
};

describe("contentTypeSchema", () => {
  it("builds a Strapi v5 collectionType schema", () => {
    expect(contentTypeSchema(article)).toEqual({
      kind: "collectionType",
      collectionName: "articles",
      info: { singularName: "article", pluralName: "articles", displayName: "Article" },
      options: { draftAndPublish: true },
      pluginOptions: {},
      attributes: { title: { type: "string", required: true } },
    });
  });

  it("omits draftAndPublish when draftPublish is false/absent", () => {
    const s = contentTypeSchema({ ...article, options: {} });
    expect(s.options).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/schema.test.ts`
Expected: FAIL — cannot resolve `./schema`.

- [ ] **Step 3: Implement**

`packages/adapter-strapi/src/schema.ts`
```ts
import type { ContentType } from "@camis/ir-schema";
import { toAttributes } from "./attributes";
import { strapiNames } from "./names";

export const contentTypeSchema = (ct: ContentType): Record<string, unknown> => {
  const names = strapiNames(ct);
  const options: Record<string, unknown> = {};
  if (ct.options?.draftPublish) options.draftAndPublish = true;
  return {
    kind: ct.kind === "single" ? "singleType" : "collectionType",
    collectionName: names.collectionName,
    info: { singularName: names.singularName, pluralName: names.pluralName, displayName: names.displayName },
    options,
    pluginOptions: {},
    attributes: toAttributes(ct.fields),
  };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): content-type schema.json builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: API factory files (controller/route/service)

**Files:**
- Create: `packages/adapter-strapi/src/api-files.ts`
- Test: `packages/adapter-strapi/src/api-files.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapter-strapi/src/api-files.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { apiFactoryFiles } from "./api-files";

describe("apiFactoryFiles", () => {
  it("emits controller, route, and service factory files under the api dir", () => {
    const files = apiFactoryFiles({ singularName: "article", uid: "api::article.article" });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(Object.keys(byPath).sort()).toEqual([
      "src/api/article/controllers/article.ts",
      "src/api/article/routes/article.ts",
      "src/api/article/services/article.ts",
    ]);
    expect(byPath["src/api/article/controllers/article.ts"]).toContain('createCoreController("api::article.article")');
    expect(byPath["src/api/article/controllers/article.ts"]).toContain("@camis:generated");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/api-files.test.ts`
Expected: FAIL — cannot resolve `./api-files`.

- [ ] **Step 3: Implement**

`packages/adapter-strapi/src/api-files.ts`
```ts
import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";

interface ApiNames {
  singularName: string;
  uid: string;
}

const factory = (kind: "Controller" | "Router" | "Service", uid: string): string =>
  withMarker(`import { factories } from "@strapi/strapi";\n\nexport default factories.createCore${kind}("${uid}");\n`);

export const apiFactoryFiles = ({ singularName, uid }: ApiNames): GeneratedFile[] => {
  const base = `src/api/${singularName}`;
  return [
    { path: `${base}/controllers/${singularName}.ts`, content: factory("Controller", uid) },
    { path: `${base}/routes/${singularName}.ts`, content: factory("Router", uid) },
    { path: `${base}/services/${singularName}.ts`, content: factory("Service", uid) },
  ];
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/api-files.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): API factory files

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Strapi skeleton templates (capture-from-scaffold + emit)

**Files:**
- Create: `packages/adapter-strapi/src/skeleton/` (template strings)
- Create: `packages/adapter-strapi/src/skeleton.ts` (`skeletonFiles`)
- Test: `packages/adapter-strapi/src/skeleton.test.ts`

> **D10 — derive from a real scaffold:** In a scratch dir, run
> `npx create-strapi-app@5 strapi-ref --quickstart --skip-cloud --no-run --use-npm --typescript`
> (non-interactive; uses sqlite). Open `strapi-ref/` and copy the **exact** contents of these files
> into template strings, replacing the project name with `${projectName}` only in `package.json`:
> `package.json`, `tsconfig.json`, `config/server.ts`, `config/admin.ts`, `config/api.ts`,
> `config/middlewares.ts`, `config/database.ts`, `src/index.ts`. Pin `@strapi/strapi` to the exact
> version the scaffold produced (record it in a comment). This guarantees the skeleton boots.
> The `.env` is authored by us (deterministic placeholders), NOT copied (the scaffold randomizes it).

- [ ] **Step 1: Write the failing test**

`packages/adapter-strapi/src/skeleton.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { skeletonFiles } from "./skeleton";

describe("skeletonFiles", () => {
  it("emits the minimal bootable Strapi project files", () => {
    const paths = skeletonFiles("blog").map((f) => f.path).sort();
    expect(paths).toEqual([
      ".env",
      "config/admin.ts",
      "config/api.ts",
      "config/database.ts",
      "config/middlewares.ts",
      "config/server.ts",
      "package.json",
      "src/index.ts",
      "tsconfig.json",
    ]);
  });

  it("pins @strapi/strapi to an exact version and sets the project name", () => {
    const pkg = JSON.parse(skeletonFiles("blog").find((f) => f.path === "package.json")!.content);
    expect(pkg.name).toBe("blog");
    expect(pkg.dependencies["@strapi/strapi"]).toMatch(/^5\.\d+\.\d+$/);
  });

  it("marks .env as seed mode with deterministic placeholder secrets", () => {
    const env = skeletonFiles("blog").find((f) => f.path === ".env")!;
    expect(env.mode).toBe("seed");
    expect(env.content).toContain("APP_KEYS=");
  });

  it("database.ts defaults to sqlite", () => {
    const db = skeletonFiles("blog").find((f) => f.path === "config/database.ts")!;
    expect(db.content).toContain("sqlite");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/skeleton.test.ts`
Expected: FAIL — cannot resolve `./skeleton`.

- [ ] **Step 3: Implement**

Create `packages/adapter-strapi/src/skeleton/` with one `.ts` module per template exporting a
string constant (or a single `templates.ts` with all constants), filled with the **captured**
scaffold contents per the D10 note above. Then `packages/adapter-strapi/src/skeleton.ts`:
```ts
import type { GeneratedFile } from "@camis/adapter-kernel";
import {
  ADMIN_TS, API_TS, DATABASE_TS, MIDDLEWARES_TS, SERVER_TS, SRC_INDEX_TS, TSCONFIG_JSON,
  packageJson, ENV,
} from "./skeleton/templates";

export const skeletonFiles = (projectName: string): GeneratedFile[] => [
  { path: "package.json", content: packageJson(projectName) },
  { path: "tsconfig.json", content: TSCONFIG_JSON },
  { path: "config/server.ts", content: SERVER_TS },
  { path: "config/admin.ts", content: ADMIN_TS },
  { path: "config/api.ts", content: API_TS },
  { path: "config/middlewares.ts", content: MIDDLEWARES_TS },
  { path: "config/database.ts", content: DATABASE_TS },
  { path: "src/index.ts", content: SRC_INDEX_TS },
  { path: ".env", content: ENV, mode: "seed" },
];
```
`packageJson(projectName)` returns the captured package.json JSON string with `"name"` set to
`projectName` and `@strapi/strapi` pinned. `ENV` contains fixed placeholders, e.g.:
```
APP_KEYS=camisDevKeyA,camisDevKeyB
API_TOKEN_SALT=camisDevApiTokenSalt
ADMIN_JWT_SECRET=camisDevAdminJwtSecret
TRANSFER_TOKEN_SALT=camisDevTransferTokenSalt
JWT_SECRET=camisDevJwtSecret
```
`DATABASE_TS` is the sqlite config (from the spec): client `sqlite`, `DATABASE_FILENAME` default
`.tmp/data.db`, `useNullAsDefault: true`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/skeleton.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): bootable Strapi skeleton templates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: generate() adapter + public surface

**Files:**
- Create: `packages/adapter-strapi/src/generate.ts`
- Create: `packages/adapter-strapi/src/index.ts`
- Test: `packages/adapter-strapi/src/generate.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapter-strapi/src/generate.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { strapiAdapter } from "./generate";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }, { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" }], options: { draftPublish: true } },
    { name: "Author", kind: "collection", fields: [{ type: "string", name: "name" }] },
  ],
  components: [],
};

describe("strapiAdapter.generate", () => {
  it("emits a schema.json + api files for every content type, plus the skeleton", () => {
    const result = strapiAdapter.generate(doc, { projectName: "blog" });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/api/article/content-types/article/schema.json");
    expect(paths).toContain("src/api/author/content-types/author/schema.json");
    expect(paths).toContain("package.json");
    expect(result.manifest.files.length).toBeGreaterThan(0);
  });

  it("derives names even if the input is not pre-normalized (generate normalizes)", () => {
    const result = strapiAdapter.generate(doc, { projectName: "blog" });
    const schemaFile = result.files.find((f) => f.path.endsWith("article/schema.json"))!;
    expect(JSON.parse(schemaFile.content).info.pluralName).toBe("articles");
  });

  it("reports softDelete as a capability gap", () => {
    const withSoftDelete: IrDocument = {
      ...doc,
      contentTypes: [{ ...doc.contentTypes[0]!, options: { softDelete: true } }, doc.contentTypes[1]!],
    };
    const result = strapiAdapter.generate(withSoftDelete, { projectName: "blog" });
    expect(result.gaps.gaps.some((g) => g.feature === "softDelete")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/generate.test.ts`
Expected: FAIL — cannot resolve `./generate`.

- [ ] **Step 3: Implement**

`packages/adapter-strapi/src/generate.ts`
```ts
import { buildManifest, stableJson, type GenerateAdapter, type GeneratedFile, type GenerationResult } from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import { apiFactoryFiles } from "./api-files";
import { strapiNames } from "./names";
import { contentTypeSchema } from "./schema";
import { skeletonFiles } from "./skeleton";

const typeFiles = (ct: ContentType): GeneratedFile[] => {
  const names = strapiNames(ct);
  return [
    {
      path: `src/api/${names.singularName}/content-types/${names.singularName}/schema.json`,
      content: stableJson(contentTypeSchema(ct)),
    },
    ...apiFactoryFiles(names),
  ];
};

const softDeleteGaps = (doc: IrDocument): CapabilityGap[] =>
  doc.contentTypes
    .filter((ct) => ct.options?.softDelete)
    .map((ct): CapabilityGap => ({
      feature: "softDelete",
      location: { contentType: ct.name },
      severity: "downgrade",
      message: `Strapi has no native soft delete; "${ct.name}" softDelete is dropped.`,
    }));

export const strapiAdapter: GenerateAdapter = {
  target: "strapi",
  generate: (input: IrDocument, options): GenerationResult => {
    const doc = normalize(input);
    const files: GeneratedFile[] = [...skeletonFiles(options.projectName), ...doc.contentTypes.flatMap(typeFiles)];
    return {
      files,
      manifest: buildManifest(files),
      gaps: { target: "strapi", gaps: softDeleteGaps(doc) },
    };
  },
};
```

`packages/adapter-strapi/src/index.ts` (replace stub):
```ts
export { strapiAdapter } from "./generate";
export { contentTypeSchema } from "./schema";
export { strapiNames } from "./names";
```

- [ ] **Step 4: Run test + typecheck + full package suite**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run`
Run: `pnpm --filter @camis/adapter-strapi typecheck`
Expected: all PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): generate adapter wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 14: golden snapshot + idempotency

**Files:**
- Create: `packages/adapter-strapi/src/__fixtures__/blog.ts`
- Create: `packages/adapter-strapi/src/golden.test.ts`
- Created on first run: `packages/adapter-strapi/src/__golden__/*` (snapshots)

- [ ] **Step 1: Write the fixture**

`packages/adapter-strapi/src/__fixtures__/blog.ts`
```ts
import type { IrDocument } from "@camis/ir-schema";

export const blog: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "uid", name: "slug", targetField: "title" },
        { type: "richText", name: "body" },
        { type: "enumeration", name: "status", values: ["draft", "published"], default: "draft" },
        { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" },
      ],
      options: { draftPublish: true },
    },
    { name: "Author", kind: "collection", fields: [{ type: "string", name: "name", required: true }] },
  ],
  components: [],
};
```

- [ ] **Step 2: Write the golden + idempotency test**

`packages/adapter-strapi/src/golden.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";

describe("golden", () => {
  it("Article schema.json matches the golden snapshot byte-for-byte", async () => {
    const result = strapiAdapter.generate(blog, { projectName: "blog" });
    const schema = result.files.find((f) => f.path.endsWith("article/schema.json"))!.content;
    await expect(schema).toMatchFileSnapshot("./__golden__/article.schema.json");
  });

  it("the full emitted file manifest matches the golden snapshot", async () => {
    const result = strapiAdapter.generate(blog, { projectName: "blog" });
    const listing = result.files.map((f) => `${f.mode ?? "overwrite"} ${f.path}`).sort().join("\n");
    await expect(listing).toMatchFileSnapshot("./__golden__/file-listing.txt");
  });

  it("regeneration is idempotent (identical result)", () => {
    const a = strapiAdapter.generate(blog, { projectName: "blog" });
    const b = strapiAdapter.generate(blog, { projectName: "blog" });
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 3: Run once to GENERATE the goldens, then inspect them**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/golden.test.ts`
Expected: PASS (Vitest writes the `__golden__/*` files on first run). **Open `__golden__/article.schema.json`
and verify by eye** that it is a valid Strapi v5 schema (kind `collectionType`, `info` with
kebab names, `attributes` with `richtext`, `enumeration` with `enum`, the `relation` with
`api::author.author` + `inversedBy`). Fix the mapping if anything is wrong, delete the golden, rerun.

- [ ] **Step 4: Re-run to confirm the goldens now compare green**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/golden.test.ts`
Expected: PASS (3 tests) comparing against the committed goldens.

- [ ] **Step 5: Commit (including the golden files)**

```bash
git add packages/adapter-strapi
git commit -m "test(adapter-strapi): golden snapshots and idempotency

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 15: repo wiring — generated/, formatter ignores, boundaries, docs

**Files:**
- Modify: `.gitignore`, `.prettierignore`, `eslint.config.js`, `pnpm-workspace.yaml` (verify), `docs/ARCHITECTURE.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Ignore generated output and exclude goldens/fixtures from formatters**

Append to `.gitignore`:
```
# Generated CMS project outputs (disposable; see ARCHITECTURE)
generated/
```
Append to `.prettierignore`:
```
**/__golden__/**
**/__fixtures__/**
generated
```
In `eslint.config.js`, add to the top-level `ignores` array: `"**/__golden__/**"`, `"generated/**"`.
(Leave `**/__fixtures__/**` lintable — fixtures are real TS; only goldens must be byte-stable. If a
golden file has a lintable extension, the ESLint `__golden__` ignore covers it.)

- [ ] **Step 2: Extend the ESLint boundary rule to the new adapter**

In `eslint.config.js`, the adapter sibling-import block already lists `adapter-strapi`. Confirm
`packages/adapter-strapi/src/**/*.ts` is covered by the `@camis/adapter-*` no-sibling rule, and that
`adapter-kernel` is NOT restricted from importing IR packages. No rule should block
`adapter-strapi → adapter-kernel` (kernel is not an adapter sibling). Verify by running `pnpm lint`.

- [ ] **Step 3: Update the docs (generated/ vs apps/)**

In `docs/ARCHITECTURE.md` §2 and `README.md` "Layout": rename the generated-output directory from
`apps/` to `generated/` (git-ignored, disposable), and note `apps/` is reserved for future
management/UI applications. In `CLAUDE.md`, resolve the "Open decisions" entry: replace the pending
`apps/` line with the settled decision (generated output → `generated/`, git-ignored; `apps/`
reserved). Keep edits minimal and consistent with the existing wording.

- [ ] **Step 4: Verify the full sweep**

Run:
```bash
pnpm lint
pnpm -r typecheck
pnpm -r test
```
Expected: all green (adapter-kernel + adapter-strapi suites included).

- [ ] **Step 5: Commit**

```bash
git add .gitignore .prettierignore eslint.config.js docs/ARCHITECTURE.md README.md CLAUDE.md pnpm-workspace.yaml
git commit -m "chore: wire generated/ output, golden lint-ignores, and docs for Phase 2

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 16: structural smoke + gated boot smoke

**Files:**
- Create: `packages/adapter-strapi/src/smoke.structural.test.ts`
- Create: `packages/adapter-strapi/scripts/boot-smoke.mjs`
- Modify: `packages/adapter-strapi/package.json` (add `smoke` script)
- Create: `.github/workflows/strapi-boot-smoke.yml`

- [ ] **Step 1: Structural smoke test (fast, per-commit)**

`packages/adapter-strapi/src/smoke.structural.test.ts`
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "camis-strapi-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("structural smoke", () => {
  it("materializes a well-formed project tree", async () => {
    await materialize(strapiAdapter.generate(blog, { projectName: "blog" }), dir);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    const schema = JSON.parse(await readFile(join(dir, "src/api/article/content-types/article/schema.json"), "utf8"));
    expect(schema.kind).toBe("collectionType");
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@strapi/strapi"]).toMatch(/^5\./);
  });

  it("materialize is idempotent on disk (second run leaves files unchanged)", async () => {
    const result = strapiAdapter.generate(blog, { projectName: "blog" });
    await materialize(result, dir);
    const before = await readFile(join(dir, "src/api/article/content-types/article/schema.json"), "utf8");
    await materialize(result, dir);
    const after = await readFile(join(dir, "src/api/article/content-types/article/schema.json"), "utf8");
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: Run the structural smoke**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/smoke.structural.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Boot-smoke script (gated; not run in unit CI)**

`packages/adapter-strapi/scripts/boot-smoke.mjs`
```js
// Generates, materializes, installs, boots Strapi on sqlite, and asserts the Article
// route is registered (200 or 403 — both prove it's exposed; 404/500 fail).
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "../src/generate.ts";
import { blog } from "../src/__fixtures__/blog.ts";

const dir = await mkdtemp(join(tmpdir(), "camis-boot-"));
try {
  await materialize(strapiAdapter.generate(blog, { projectName: "blog" }), dir);
  execSync("npm install --no-audit --no-fund", { cwd: dir, stdio: "inherit" });
  const proc = spawn("npm", ["run", "develop"], { cwd: dir, stdio: "inherit", env: { ...process.env, BROWSER: "none" } });
  const ok = await pollUntilRegistered("http://127.0.0.1:1337/api/articles", 120_000);
  proc.kill("SIGTERM");
  if (!ok) { console.error("Article route not registered"); process.exit(1); }
  console.log("BOOT SMOKE PASS: Article route registered");
} finally {
  await rm(dir, { recursive: true, force: true });
}

async function pollUntilRegistered(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200 || res.status === 403) return true; // registered (403 = default-deny)
      if (res.status === 404) return false;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
```
Add to `packages/adapter-strapi/package.json` scripts: `"smoke": "node scripts/boot-smoke.mjs"`.

- [ ] **Step 4: Gated CI workflow (Node 20, manual/nightly)**

`.github/workflows/strapi-boot-smoke.yml`
```yaml
name: strapi-boot-smoke
on:
  workflow_dispatch:
  schedule:
    - cron: "0 4 * * *"
jobs:
  boot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @camis/adapter-strapi smoke
```

- [ ] **Step 5: Run the boot smoke locally to prove it works**

Run: `pnpm --filter @camis/adapter-strapi smoke`
Expected: installs Strapi, boots on sqlite, prints `BOOT SMOKE PASS: Article route registered`.
(If boot fails, the captured skeleton is wrong — fix the Task 12 templates against the real scaffold
output and re-run. This is the authoritative bootability check.)

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-strapi .github/workflows/strapi-boot-smoke.yml
git commit -m "test(adapter-strapi): structural smoke and gated boot smoke

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 generated/ (Task 15) · D2 not-workspace-member (Task 15 verify) · D3 in-memory generate + materialize (Tasks 1,5,13) · D4 from-scratch generation (Task 12) · D5 hybrid testing (Tasks 14,16) · D6 programmatic generate, no CLI (Task 13) · D7 softDelete gap + timestamps no-op (Task 13, schema omits) · D8 seed mode (Tasks 5,6,12) · D9 pinned Strapi version (Task 12 test) · D10 derive-from-scaffold (Task 12 note) · D11 generate normalizes (Task 13 test) · D12 determinism: stableJson insertion order (Task 2), fixed .env secrets (Task 12), manifest self-excluded (Task 4). Name projection (Task 7), field casing + relations (Tasks 8,9), schema builder (Task 10), API factory files (Task 11), golden byte-compare + idempotency (Task 14), structural + boot smoke (Task 16). Doc updates (Task 15).

**Placeholder scan:** none — all code/commands concrete except the Task 12 skeleton, which is intentionally captured from a real scaffold (an external artifact) with an exact command, file list, and verification; the boot smoke (Task 16) validates it.

**Type consistency:** `GeneratedFile`/`GenerationResult`/`Manifest`/`GenerateAdapter` (Task 1) used unchanged across kernel (Tasks 2–6) and adapter (Tasks 7–16); `strapiNames`/`StrapiNames` (Task 7) consumed by `schema.ts`/`generate.ts`; `toAttribute`/`toAttributes` (Tasks 8,9) by `schema.ts`; `apiFactoryFiles` (Task 11) and `skeletonFiles` (Task 12) by `generate.ts`; `stableJson`/`buildManifest`/`materialize`/`withMarker` imported from `@camis/adapter-kernel` consistently.
