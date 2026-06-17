# Phase 3 — Strapi Import (Round-Trip) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse a Strapi v5 `schema.json` back into validated IR and prove `import(generate(ir)) ≅ ir`, completing the deferred component generate path and fixing relations to be two-sided.

**Architecture:** Generate gains component emission, media `multiple`/`allowedTypes`, two-sided bidirectional relations (owner `inversedBy` + synthesized inverse `mappedBy`), and dynamicZone capability-gaps. A new pure `importDocument(files)` reads ONLY declarative `schema.json`/component json, runs reverse mappers (inverses of the generate mappers), collapses `mappedBy` inverse attributes, validates via `ir-core`, and reports unrepresentable constructs as `CapabilityGap`s. A thin `readStrapiProject(dir)` loads from disk. Round-trip property tests assert normalized equality on curated fixtures.

**Tech Stack:** TypeScript (strict, ESM, `moduleResolution: Bundler`, extensionless relative imports, `import type`), Vitest (incl. `toMatchFileSnapshot`), Node `fs/promises`.

**Reference:** `docs/superpowers/specs/2026-06-16-phase-3-strapi-import-design.md` (D1–D10). Existing `adapter-strapi/src/`: `names.ts` (`strapiNames`, `kebab` exported), `attributes.ts` (`toAttribute`, `toAttributes`), `schema.ts` (`contentTypeSchema`), `api-files.ts`, `skeleton.ts`, `generate.ts` (`strapiAdapter`), `__fixtures__/blog.ts`, `__golden__/`. `@camis/ir-schema` exports `FIELD_TYPES`, `RELATION_KINDS`, types `CapabilityGap`, `Component`, `ContentType`, `Field`, `IrDocument`, `RelationKind`. `@camis/ir-core` exports `normalize`, `validate`. `@camis/adapter-kernel` exports `stableJson`, `materialize`, `buildManifest`, type `GeneratedFile`.

**Conventions:** commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. `import type` for type-only. Single test file: `pnpm --filter @camis/adapter-strapi exec vitest run src/<file>.test.ts`.

---

## File structure

**Generate (modify/add under `adapter-strapi/src/`)**
- `attributes.ts` — add media `multiple`/`allowedTypes` + a `component` branch; `toAttributes` skips `dynamicZone`.
- `relations.ts` (new) — `dual(kind)` + `synthesizedInverses(doc)`.
- `component-schema.ts` (new) — `componentSchema(component)`.
- `schema.ts` — `contentTypeSchema(ct, extraAttributes?)`.
- `generate.ts` — emit component files, append synthesized inverses, dynamicZone gaps.

**Import (new under `adapter-strapi/src/import/`)**
- `names.ts` — `irName(kebab)`.
- `attributes.ts` — `irField(name, attr, location)`.
- `schema.ts` — `irContentType(schema)`, `irComponent(componentName, schema)`.
- `import-document.ts` — `importDocument(files)`.
- `read-project.ts` — `readStrapiProject(dir)`.

---

## Task 1: media multiple/allowedTypes + dynamicZone skip (generate)

**Files:** Modify `packages/adapter-strapi/src/attributes.ts`; Test `packages/adapter-strapi/src/attributes.test.ts` (append)

- [ ] **Step 1: Append failing tests**

```ts
describe("toAttribute — media", () => {
  it("carries multiple and allowedTypes", () => {
    expect(toAttribute({ type: "media", name: "cover", multiple: true, allowedTypes: ["image", "video"] }))
      .toEqual({ type: "media", multiple: true, allowedTypes: ["image", "video"] });
  });
});

describe("toAttributes — dynamicZone", () => {
  it("skips dynamicZone fields (deferred; generate reports a gap)", () => {
    const attrs = toAttributes([
      { type: "string", name: "title" },
      { type: "dynamicZone", name: "blocks", components: ["Hero"] },
    ]);
    expect(Object.keys(attrs)).toEqual(["title"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/attributes.test.ts`
Expected: FAIL (media drops multiple/allowedTypes; dynamicZone currently emitted).

- [ ] **Step 3: Implement**

In `attributes.ts`, add media handling in the generic block and skip dynamicZone in `toAttributes`. After the existing `put(attr, "targetField", f.targetField);` line in the generic block, add:
```ts
  put(attr, "multiple", f.multiple);
  put(attr, "allowedTypes", f.allowedTypes);
```
And change `toAttributes`:
```ts
export const toAttributes = (fields: Field[]): Record<string, Attribute> => {
  const out: Record<string, Attribute> = {};
  for (const field of fields) {
    if (field.type === "dynamicZone") continue; // deferred; generate emits a capability-gap
    out[field.name] = toAttribute(field);
  }
  return out;
};
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/attributes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): media constraints + skip dynamicZone in attributes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: component attribute branch (generate)

**Files:** Modify `packages/adapter-strapi/src/attributes.ts`; Test (append)

- [ ] **Step 1: Append failing test**

```ts
describe("toAttribute — component", () => {
  it("maps a component field to the shared category uid", () => {
    expect(toAttribute({ type: "component", name: "seo", component: "SeoMeta", repeatable: false }))
      .toEqual({ type: "component", component: "shared.seo-meta", repeatable: false });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/attributes.test.ts`
Expected: FAIL (no component branch).

- [ ] **Step 3: Implement**

In `attributes.ts`, import the shared `kebab` from `./names` (add `import { kebab } from "./names";` if not present — `kebab` is already exported from names.ts). Add a `component` branch right after the `relation` branch:
```ts
  if (field.type === "component") {
    attr.component = `shared.${kebab(field.component)}`;
    attr.repeatable = field.repeatable;
    return attr;
  }
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/attributes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): component attribute mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: dual() + synthesizedInverses (generate)

**Files:** Create `packages/adapter-strapi/src/relations.ts`; Test `packages/adapter-strapi/src/relations.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { dual, synthesizedInverses } from "./relations";

describe("dual", () => {
  it("pairs relation kinds", () => {
    expect(dual("manyToOne")).toBe("oneToMany");
    expect(dual("oneToMany")).toBe("manyToOne");
    expect(dual("oneToOne")).toBe("oneToOne");
    expect(dual("manyToMany")).toBe("manyToMany");
  });
});

describe("synthesizedInverses", () => {
  it("produces a mappedBy attribute on the target type for an owner relation with inverse", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        { name: "Article", kind: "collection", fields: [{ type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" }] },
        { name: "Author", kind: "collection", fields: [{ type: "string", name: "name" }] },
      ],
      components: [],
    };
    const inv = synthesizedInverses(doc);
    expect(inv.get("Author")).toEqual({
      articles: { type: "relation", relation: "oneToMany", target: "api::article.article", mappedBy: "author" },
    });
    expect(inv.get("Article")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/relations.test.ts`
Expected: FAIL — cannot resolve `./relations`.

- [ ] **Step 3: Implement**

```ts
import type { IrDocument, RelationKind } from "@camis/ir-schema";
import { kebab } from "./names";

const DUAL: Record<RelationKind, RelationKind> = {
  oneToOne: "oneToOne",
  oneToMany: "manyToOne",
  manyToOne: "oneToMany",
  manyToMany: "manyToMany",
};

export const dual = (kind: RelationKind): RelationKind => DUAL[kind];

// Map<targetTypeName, { [inverseFieldName]: strapiRelationAttribute }>
export const synthesizedInverses = (doc: IrDocument): Map<string, Record<string, unknown>> => {
  const byTarget = new Map<string, Record<string, unknown>>();
  for (const ct of doc.contentTypes) {
    for (const f of ct.fields) {
      if (f.type === "relation" && f.inverse !== undefined) {
        const ownerSingular = kebab(ct.name);
        const bucket = byTarget.get(f.target) ?? {};
        bucket[f.inverse] = {
          type: "relation",
          relation: DUAL[f.relationKind],
          target: `api::${ownerSingular}.${ownerSingular}`,
          mappedBy: f.name,
        };
        byTarget.set(f.target, bucket);
      }
    }
  }
  return byTarget;
};
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/relations.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): dual relation kinds and synthesized inverses

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: component-schema.ts (generate)

**Files:** Create `packages/adapter-strapi/src/component-schema.ts`; Test `packages/adapter-strapi/src/component-schema.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import type { Component } from "@camis/ir-schema";
import { componentSchema } from "./component-schema";

const seo: Component = { name: "SeoMeta", fields: [{ type: "string", name: "metaTitle" }] };

describe("componentSchema", () => {
  it("builds a Strapi component json", () => {
    expect(componentSchema(seo)).toEqual({
      collectionName: "components_shared_seo_metas",
      info: { displayName: "Seo Meta" },
      options: {},
      attributes: { metaTitle: { type: "string" } },
    });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/component-schema.test.ts`
Expected: FAIL — cannot resolve `./component-schema`.

- [ ] **Step 3: Implement**

```ts
import type { Component } from "@camis/ir-schema";
import { humanize, pluralize, snakeCase } from "@camis/ir-core";
import { toAttributes } from "./attributes";

export const componentSchema = (component: Component): Record<string, unknown> => ({
  collectionName: `components_shared_${snakeCase(pluralize(component.name))}`,
  info: { displayName: humanize(component.name) },
  options: {},
  attributes: toAttributes(component.fields),
});
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/component-schema.test.ts`
Expected: PASS. (`snakeCase(pluralize("SeoMeta"))` = `snakeCase("SeoMetas")` = `seo_metas`.)

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): component schema.json builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: schema.ts extraAttributes + generate wiring

**Files:** Modify `packages/adapter-strapi/src/schema.ts`, `packages/adapter-strapi/src/generate.ts`; Test `packages/adapter-strapi/src/generate.test.ts` (append)

- [ ] **Step 1: Append failing tests**

```ts
describe("strapiAdapter.generate — components + inverses", () => {
  const doc = {
    version: 1 as const,
    contentTypes: [
      { name: "Article", kind: "collection" as const, fields: [
        { type: "relation" as const, name: "author", relationKind: "manyToOne" as const, target: "Author", inverse: "articles" },
        { type: "component" as const, name: "seo", component: "SeoMeta", repeatable: false },
        { type: "dynamicZone" as const, name: "blocks", components: ["SeoMeta"] },
      ] },
      { name: "Author", kind: "collection" as const, fields: [{ type: "string" as const, name: "name" }] },
    ],
    components: [{ name: "SeoMeta", fields: [{ type: "string" as const, name: "metaTitle" }] }],
  };

  it("emits a component json file", () => {
    const r = strapiAdapter.generate(doc, { projectName: "blog" });
    expect(r.files.map((f) => f.path)).toContain("src/components/shared/seo-meta.json");
  });

  it("adds the synthesized inverse attribute to the target type schema", () => {
    const r = strapiAdapter.generate(doc, { projectName: "blog" });
    const author = JSON.parse(r.files.find((f) => f.path.endsWith("author/schema.json"))!.content);
    expect(author.attributes.articles).toEqual({ type: "relation", relation: "oneToMany", target: "api::article.article", mappedBy: "author" });
  });

  it("reports dynamicZone as a capability gap and omits it", () => {
    const r = strapiAdapter.generate(doc, { projectName: "blog" });
    expect(r.gaps.gaps.some((g) => g.feature === "dynamicZone")).toBe(true);
    const article = JSON.parse(r.files.find((f) => f.path.endsWith("article/schema.json"))!.content);
    expect(article.attributes.blocks).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/generate.test.ts`
Expected: FAIL (no component files, no inverse, no dynamicZone gap).

- [ ] **Step 3: Modify `schema.ts`** — accept extra attributes:
```ts
export const contentTypeSchema = (ct: ContentType, extraAttributes: Record<string, unknown> = {}): Record<string, unknown> => {
  const names = strapiNames(ct);
  const options: Record<string, unknown> = {};
  if (ct.options?.draftPublish) options.draftAndPublish = true;
  return {
    kind: ct.kind === "single" ? "singleType" : "collectionType",
    collectionName: names.collectionName,
    info: { singularName: names.singularName, pluralName: names.pluralName, displayName: names.displayName },
    options,
    pluginOptions: {},
    attributes: { ...toAttributes(ct.fields), ...extraAttributes },
  };
};
```

- [ ] **Step 4: Modify `generate.ts`** — wire components, inverses, dynamicZone gaps. Full file:
```ts
import { buildManifest, stableJson, type GenerateAdapter, type GeneratedFile, type GenerationResult } from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap, Component, ContentType, IrDocument } from "@camis/ir-schema";
import { apiFactoryFiles } from "./api-files";
import { componentSchema } from "./component-schema";
import { kebab, strapiNames } from "./names";
import { contentTypeSchema } from "./schema";
import { synthesizedInverses } from "./relations";
import { skeletonFiles } from "./skeleton";

const typeFiles = (ct: ContentType, extraAttributes: Record<string, unknown>): GeneratedFile[] => {
  const names = strapiNames(ct);
  return [
    {
      path: `src/api/${names.singularName}/content-types/${names.singularName}/schema.json`,
      content: stableJson(contentTypeSchema(ct, extraAttributes)),
    },
    ...apiFactoryFiles(names),
  ];
};

const componentFile = (component: Component): GeneratedFile => ({
  path: `src/components/shared/${kebab(component.name)}.json`,
  content: stableJson(componentSchema(component)),
});

const softDeleteGaps = (doc: IrDocument): CapabilityGap[] =>
  doc.contentTypes
    .filter((ct) => ct.options?.softDelete)
    .map((ct): CapabilityGap => ({ feature: "softDelete", location: { contentType: ct.name }, severity: "downgrade", message: `Strapi has no native soft delete; "${ct.name}" softDelete is dropped.` }));

const dynamicZoneGaps = (doc: IrDocument): CapabilityGap[] =>
  doc.contentTypes.flatMap((ct) =>
    ct.fields
      .filter((f) => f.type === "dynamicZone")
      .map((f): CapabilityGap => ({ feature: "dynamicZone", location: { contentType: ct.name, field: f.name }, severity: "downgrade", message: `dynamicZone is not supported yet; "${ct.name}.${f.name}" is dropped.` })),
  );

export const strapiAdapter: GenerateAdapter = {
  target: "strapi",
  generate: (input: IrDocument, options): GenerationResult => {
    const doc = normalize(input);
    const inverses = synthesizedInverses(doc);
    const files: GeneratedFile[] = [
      ...skeletonFiles(options.projectName),
      ...doc.contentTypes.flatMap((ct) => typeFiles(ct, inverses.get(ct.name) ?? {})),
      ...doc.components.map(componentFile),
    ];
    return {
      files,
      manifest: buildManifest(files),
      gaps: { target: "strapi", gaps: [...softDeleteGaps(doc), ...dynamicZoneGaps(doc)] },
    };
  },
};
```

- [ ] **Step 5: Run generate tests + the existing golden test (Phase 2 blog has no components/inverse-targets, so its goldens are unchanged)**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/generate.test.ts src/golden.test.ts`
Expected: PASS. (The Phase 2 blog fixture's `Author` has no inverse pointing at it that changes `article.schema.json`; the synthesized `articles` inverse lands on `Author`, whose schema is not goldened. If `golden.test.ts` fails, STOP and report — the Phase 2 golden should be unaffected.)

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @camis/adapter-strapi typecheck`
```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): emit components, two-sided relations, dynamicZone gaps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: import — irName

**Files:** Create `packages/adapter-strapi/src/import/names.ts`; Test `packages/adapter-strapi/src/import/names.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { irName } from "./names";

describe("irName", () => {
  it("PascalCases a kebab singular", () => {
    expect(irName("article")).toBe("Article");
    expect(irName("blog-post")).toBe("BlogPost");
    expect(irName("seo-meta")).toBe("SeoMeta");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/names.test.ts`
Expected: FAIL — cannot resolve `./names`.

- [ ] **Step 3: Implement**

```ts
export const irName = (kebab: string): string =>
  kebab
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/names.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): import irName reverse projection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: import — irField (scalars, casing, media, enum, uid)

**Files:** Create `packages/adapter-strapi/src/import/attributes.ts`; Test `packages/adapter-strapi/src/import/attributes.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { irField } from "./attributes";

const loc = { contentType: "Article" };

describe("irField — scalars", () => {
  it("reverses casing", () => {
    expect(irField("body", { type: "richtext" }, loc).field).toEqual({ type: "richText", name: "body" });
    expect(irField("n", { type: "biginteger" }, loc).field).toEqual({ type: "bigInteger", name: "n" });
    expect(irField("at", { type: "datetime" }, loc).field).toEqual({ type: "dateTime", name: "at" });
  });
  it("copies constraints", () => {
    expect(irField("title", { type: "string", required: true, maxLength: 200 }, loc).field)
      .toEqual({ type: "string", name: "title", required: true, maxLength: 200 });
  });
  it("reverses enumeration", () => {
    expect(irField("status", { type: "enumeration", enum: ["draft", "live"], default: "draft" }, loc).field)
      .toEqual({ type: "enumeration", name: "status", values: ["draft", "live"], default: "draft" });
  });
  it("reverses media", () => {
    expect(irField("cover", { type: "media", multiple: true, allowedTypes: ["image"] }, loc).field)
      .toEqual({ type: "media", name: "cover", multiple: true, allowedTypes: ["image"] });
  });
  it("reverses uid targetField", () => {
    expect(irField("slug", { type: "uid", targetField: "title" }, loc).field)
      .toEqual({ type: "uid", name: "slug", targetField: "title" });
  });
  it("returns a gap for an unknown type", () => {
    const r = irField("weird", { type: "customField" }, loc);
    expect(r.field).toBeUndefined();
    expect(r.gap?.feature).toBe("customField");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/attributes.test.ts`
Expected: FAIL — cannot resolve `./attributes`.

- [ ] **Step 3: Implement (scalars half; relation/component added in Task 8)**

```ts
import { FIELD_TYPES, type CapabilityGap, type Field } from "@camis/ir-schema";

export interface IrFieldResult {
  field?: Field;
  gap?: CapabilityGap;
  skip?: true;
}

const REVERSE_TYPE: Record<string, string> = {
  richtext: "richText",
  biginteger: "bigInteger",
  datetime: "dateTime",
};

const SCALAR_CONSTRAINTS = ["required", "unique", "minLength", "maxLength", "min", "max", "default", "targetField", "multiple"] as const;

export const irField = (name: string, attr: Record<string, unknown>, location: CapabilityGap["location"]): IrFieldResult => {
  const strapiType = String(attr.type);
  const irType = REVERSE_TYPE[strapiType] ?? strapiType;

  if (!(FIELD_TYPES as readonly string[]).includes(irType) || irType === "relation" || irType === "component" || irType === "dynamicZone") {
    return { gap: { feature: strapiType, location: { ...location, field: name }, severity: "downgrade", message: `Strapi attribute type "${strapiType}" on "${name}" is not representable; skipped.` } };
  }

  const field: Record<string, unknown> = { type: irType, name };
  for (const k of SCALAR_CONSTRAINTS) if (attr[k] !== undefined) field[k] = attr[k];
  if (irType === "enumeration") field.values = attr.enum;
  if (irType === "media" && attr.allowedTypes !== undefined) field.allowedTypes = attr.allowedTypes;
  return { field: field as Field };
};
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/attributes.test.ts`
Expected: PASS. (`relation`/`component` types hit the gap branch for now; Task 8 adds them — the current tests don't cover those.)

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): import scalar reverse mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: import — irField (relation collapse + component)

**Files:** Modify `packages/adapter-strapi/src/import/attributes.ts`; Test (append)

- [ ] **Step 1: Append failing tests**

```ts
describe("irField — relations + components", () => {
  it("maps an owner relation (inversedBy) to a single-declaration IR relation", () => {
    expect(irField("author", { type: "relation", relation: "manyToOne", target: "api::author.author", inversedBy: "articles" }, loc).field)
      .toEqual({ type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" });
  });
  it("maps a plain (unidirectional) relation without inverse", () => {
    expect(irField("owner", { type: "relation", relation: "oneToOne", target: "api::user.user" }, loc).field)
      .toEqual({ type: "relation", name: "owner", relationKind: "oneToOne", target: "User" });
  });
  it("skips the synthesized inverse side (mappedBy)", () => {
    const r = irField("articles", { type: "relation", relation: "oneToMany", target: "api::article.article", mappedBy: "author" }, loc);
    expect(r.skip).toBe(true);
    expect(r.field).toBeUndefined();
  });
  it("maps a component ref back to the IR component name", () => {
    expect(irField("seo", { type: "component", component: "shared.seo-meta", repeatable: false }, loc).field)
      .toEqual({ type: "component", name: "seo", component: "SeoMeta", repeatable: false });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/attributes.test.ts`
Expected: FAIL (relation/component go to the gap branch).

- [ ] **Step 3: Implement** — add, at the TOP of `irField` (before the scalar guard), handling for relation and component. Add `import { irName } from "./names";` at the top of the file. Insert:
```ts
  if (strapiType === "relation") {
    if (attr.mappedBy !== undefined) return { skip: true };
    const target = irName(String(attr.target).split("::")[1]?.split(".")[0] ?? "");
    const field: Record<string, unknown> = { type: "relation", name, relationKind: attr.relation, target };
    if (attr.inversedBy !== undefined) field.inverse = attr.inversedBy;
    return { field: field as Field };
  }
  if (strapiType === "component") {
    const compName = irName(String(attr.component).split(".").slice(1).join("-"));
    return { field: { type: "component", name, component: compName, repeatable: Boolean(attr.repeatable) } as Field };
  }
```
*(Note: `String(attr.component).split(".").slice(1).join("-")` turns `shared.seo-meta` into `seo-meta`, then `irName` → `SeoMeta`.)*

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/attributes.test.ts`
Expected: PASS (all scalar + relation + component tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): import relation collapse and component reverse mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: import — schema.ts (irContentType, irComponent)

**Files:** Create `packages/adapter-strapi/src/import/schema.ts`; Test `packages/adapter-strapi/src/import/schema.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { irComponent, irContentType } from "./schema";

describe("irContentType", () => {
  it("reverses a content-type schema, dropping mappedBy inverse attrs", () => {
    const schema = {
      kind: "collectionType",
      collectionName: "articles",
      info: { singularName: "article", pluralName: "articles", displayName: "Article" },
      options: { draftAndPublish: true },
      pluginOptions: {},
      attributes: {
        title: { type: "string", required: true },
        author: { type: "relation", relation: "manyToOne", target: "api::author.author", inversedBy: "tags" },
      },
    };
    const { contentType, gaps } = irContentType(schema);
    expect(contentType).toEqual({
      name: "Article",
      kind: "collection",
      names: { display: "Article", plural: "Articles", collection: "articles" },
      options: { draftPublish: true },
      fields: [
        { type: "string", name: "title", required: true },
        { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "tags" },
      ],
    });
    expect(gaps).toEqual([]);
  });
});

describe("irComponent", () => {
  it("reverses a component json using the path-derived name", () => {
    const schema = { collectionName: "components_shared_seo_metas", info: { displayName: "Seo Meta" }, options: {}, attributes: { metaTitle: { type: "string" } } };
    const { component } = irComponent("SeoMeta", schema);
    expect(component).toEqual({ name: "SeoMeta", fields: [{ type: "string", name: "metaTitle" }] });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/schema.test.ts`
Expected: FAIL — cannot resolve `./schema`.

- [ ] **Step 3: Implement**

```ts
import type { CapabilityGap, Component, ContentType, Field } from "@camis/ir-schema";
import { irField } from "./attributes";
import { irName } from "./names";

const fieldsFromAttributes = (
  attributes: Record<string, Record<string, unknown>>,
  location: CapabilityGap["location"],
): { fields: Field[]; gaps: CapabilityGap[] } => {
  const fields: Field[] = [];
  const gaps: CapabilityGap[] = [];
  for (const [name, attr] of Object.entries(attributes)) {
    const r = irField(name, attr, location);
    if (r.skip) continue;
    if (r.field) fields.push(r.field);
    if (r.gap) gaps.push(r.gap);
  }
  return { fields, gaps };
};

export const irContentType = (schema: Record<string, any>): { contentType: ContentType; gaps: CapabilityGap[] } => {
  const name = irName(schema.info.singularName);
  const { fields, gaps } = fieldsFromAttributes(schema.attributes ?? {}, { contentType: name });
  const contentType: ContentType = {
    name,
    kind: schema.kind === "singleType" ? "single" : "collection",
    names: { display: schema.info.displayName, plural: irName(schema.info.pluralName), collection: schema.collectionName },
    fields,
  };
  if (schema.options?.draftAndPublish) contentType.options = { draftPublish: true };
  return { contentType, gaps };
};

export const irComponent = (componentName: string, schema: Record<string, any>): { component: Component; gaps: CapabilityGap[] } => {
  const { fields, gaps } = fieldsFromAttributes(schema.attributes ?? {}, { component: componentName });
  return { component: { name: componentName, fields }, gaps };
};
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @camis/adapter-strapi typecheck`
```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): import content-type and component reverse builders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: import — importDocument

**Files:** Create `packages/adapter-strapi/src/import/import-document.ts`; Test `packages/adapter-strapi/src/import/import-document.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { importDocument } from "./import-document";

const blog = {
  version: 1 as const,
  contentTypes: [
    { name: "Article", kind: "collection" as const, fields: [
      { type: "string" as const, name: "title", required: true },
      { type: "relation" as const, name: "author", relationKind: "manyToOne" as const, target: "Author", inverse: "articles" },
      { type: "component" as const, name: "seo", component: "SeoMeta", repeatable: false },
    ] },
    { name: "Author", kind: "collection" as const, fields: [{ type: "string" as const, name: "name" }] },
  ],
  components: [{ name: "SeoMeta", fields: [{ type: "string" as const, name: "metaTitle" }] }],
};

describe("importDocument", () => {
  it("reads only declarative schema files and reconstructs IR", () => {
    const files = strapiAdapter.generate(blog, { projectName: "blog" }).files;
    const { document, gaps } = importDocument(files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes.map((c) => c.name).sort()).toEqual(["Article", "Author"]);
    expect(document.value.components.map((c) => c.name)).toEqual(["SeoMeta"]);
    // Author's synthesized `articles` inverse was collapsed away (not a real field)
    const author = document.value.contentTypes.find((c) => c.name === "Author")!;
    expect(author.fields.map((f) => f.name)).toEqual(["name"]);
    expect(gaps.gaps).toEqual([]);
  });

  it("ignores generated .ts and skeleton files", () => {
    const files = [
      { path: "package.json", content: "{}" },
      { path: "src/api/article/controllers/article.ts", content: "x" },
      { path: "src/api/article/content-types/article/schema.json", content: JSON.stringify({ kind: "collectionType", collectionName: "articles", info: { singularName: "article", pluralName: "articles", displayName: "Article" }, options: {}, pluginOptions: {}, attributes: { title: { type: "string" } } }) },
    ];
    const { document } = importDocument(files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/import-document.test.ts`
Expected: FAIL — cannot resolve `./import-document`.

- [ ] **Step 3: Implement**

```ts
import { validate } from "@camis/ir-core";
import type { CapabilityGap, CapabilityGapReport, Component, ContentType, IrDocument, Result } from "@camis/ir-schema";
import { irComponent, irContentType } from "./schema";

const CONTENT_TYPE_RE = /\/content-types\/[^/]+\/schema\.json$/;
const COMPONENT_RE = /(?:^|\/)src\/components\/[^/]+\/([^/]+)\.json$/;

export const importDocument = (files: { path: string; content: string }[]): { document: Result<IrDocument>; gaps: CapabilityGapReport } => {
  const contentTypes: ContentType[] = [];
  const components: Component[] = [];
  const gaps: CapabilityGap[] = [];

  for (const file of files) {
    if (CONTENT_TYPE_RE.test(file.path)) {
      const r = irContentType(JSON.parse(file.content));
      contentTypes.push(r.contentType);
      gaps.push(...r.gaps);
    } else {
      const m = COMPONENT_RE.exec(file.path);
      if (m) {
        const componentName = m[1]!
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join("");
        const r = irComponent(componentName, JSON.parse(file.content));
        components.push(r.component);
        gaps.push(...r.gaps);
      }
    }
  }

  const document = validate({ version: 1, contentTypes, components });
  return { document, gaps: { target: "strapi", gaps } };
};
```
*(The component name un-kebab is inlined to keep `import-document.ts` from depending on `irName` purely for the path; it matches `irName`. If you prefer, import `irName` from `./names` and call it instead — either is fine, but keep them identical.)*

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/import-document.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @camis/adapter-strapi typecheck`
```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): importDocument (declarative-only, validated)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: import — readStrapiProject + public surface

**Files:** Create `packages/adapter-strapi/src/import/read-project.ts`; Modify `packages/adapter-strapi/src/index.ts`; Test `packages/adapter-strapi/src/import/read-project.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "../generate";
import { readStrapiProject } from "./read-project";

const blog = {
  version: 1 as const,
  contentTypes: [{ name: "Article", kind: "collection" as const, fields: [{ type: "string" as const, name: "title" }] }],
  components: [],
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "camis-import-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("readStrapiProject", () => {
  it("reads a materialized project's declarative schemas into IR", async () => {
    await materialize(strapiAdapter.generate(blog, { projectName: "blog" }), dir);
    const { document } = await readStrapiProject(dir);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes.map((c) => c.name)).toEqual(["Article"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/read-project.test.ts`
Expected: FAIL — cannot resolve `./read-project`.

- [ ] **Step 3: Implement**

```ts
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CapabilityGapReport, IrDocument, Result } from "@camis/ir-schema";
import { importDocument } from "./import-document";

export const readStrapiProject = async (dir: string): Promise<{ document: Result<IrDocument>; gaps: CapabilityGapReport }> => {
  const patterns = ["src/api/*/content-types/*/schema.json", "src/components/*/*.json"];
  const files: { path: string; content: string }[] = [];
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: dir })) {
      const abs = join(dir, entry);
      files.push({ path: entry, content: await readFile(abs, "utf8") });
    }
  }
  return importDocument(files);
};
```
*(Node 22 provides `fs/promises` `glob`. If the installed Node lacks it, fall back to a small recursive `readdir` walk filtering the two path patterns — keep the same return.)*

`packages/adapter-strapi/src/index.ts` — append exports:
```ts
export { importDocument } from "./import/import-document";
export { readStrapiProject } from "./import/read-project";
```

- [ ] **Step 4: Run test + typecheck + full package**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/import/read-project.test.ts`
Run: `pnpm --filter @camis/adapter-strapi typecheck`
Run: `pnpm --filter @camis/adapter-strapi exec vitest run`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): readStrapiProject fs loader and import exports

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: round-trip property test

**Files:** Create `packages/adapter-strapi/src/__fixtures__/round-trip.ts`; Create `packages/adapter-strapi/src/round-trip.test.ts`

- [ ] **Step 1: Round-trip fixture**

`packages/adapter-strapi/src/__fixtures__/round-trip.ts`
```ts
import type { IrDocument } from "@camis/ir-schema";

// Only round-trippable features: PascalCase names, scalars, a bidirectional relation,
// a component (+ nested component), media. No softDelete/timestamps/dynamicZone/acronyms.
export const roundTrip: IrDocument = {
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
        { type: "media", name: "cover", multiple: false, allowedTypes: ["image"] },
        { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" },
        { type: "component", name: "seo", component: "SeoMeta", repeatable: false },
      ],
      options: { draftPublish: true },
    },
    { name: "Author", kind: "collection", fields: [{ type: "string", name: "name", required: true }] },
  ],
  components: [{ name: "SeoMeta", fields: [{ type: "string", name: "metaTitle" }] }],
};
```

- [ ] **Step 2: Failing round-trip test**

`packages/adapter-strapi/src/round-trip.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { strapiAdapter } from "./generate";
import { importDocument } from "./import/import-document";
import { roundTrip } from "./__fixtures__/round-trip";

describe("round-trip", () => {
  it("import(generate(ir)) normalizes to the same IR", () => {
    const files = strapiAdapter.generate(roundTrip, { projectName: "blog" }).files;
    const { document, gaps } = importDocument(files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(gaps.gaps).toEqual([]);
    expect(normalize(document.value)).toEqual(normalize(roundTrip));
  });
});
```

- [ ] **Step 3: Run — expect FAIL or PASS-after-debug**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/round-trip.test.ts`
Expected: This is the SPINE test. If it fails, the diff between `normalize(document.value)` and
`normalize(roundTrip)` pinpoints an asymmetry (a mapper that isn't a true inverse). Debug the
specific mapper (names, attributes, relation collapse, component) until they are exact inverses.
Do NOT weaken the assertion — fix the mapper. Likely suspects: field ordering, a constraint not
copied symmetrically, the component name un-kebab, or `names` reconstruction.

- [ ] **Step 4: Confirm PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/round-trip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "test(adapter-strapi): round-trip property test (generate -> import)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: import unsupported-construct gap + golden for component/inverse output

**Files:** `packages/adapter-strapi/src/import/import-document.test.ts` (append); `packages/adapter-strapi/src/golden.test.ts` (append)

- [ ] **Step 1: Append an import-gap test**

In `import-document.test.ts`:
```ts
it("reports an unsupported attribute as a gap, not a field", () => {
  const files = [
    { path: "src/api/article/content-types/article/schema.json", content: JSON.stringify({ kind: "collectionType", collectionName: "articles", info: { singularName: "article", pluralName: "articles", displayName: "Article" }, options: {}, pluginOptions: {}, attributes: { title: { type: "string" }, blocks: { type: "dynamiczone", components: ["shared.seo-meta"] } } }) },
  ];
  const { document, gaps } = importDocument(files);
  expect(gaps.gaps.some((g) => g.feature === "dynamiczone")).toBe(true);
  expect(document.ok).toBe(true);
  if (!document.ok) return;
  expect(document.value.contentTypes[0]!.fields.map((f) => f.name)).toEqual(["title"]);
});
```

- [ ] **Step 2: Append a golden for the new generate outputs**

In `golden.test.ts` (uses the round-trip fixture so it exercises components + inverses):
```ts
import { roundTrip } from "./__fixtures__/round-trip";

it("component schema.json matches the golden", async () => {
  const result = strapiAdapter.generate(roundTrip, { projectName: "blog" });
  const comp = result.files.find((f) => f.path === "src/components/shared/seo-meta.json")!.content;
  await expect(comp).toMatchFileSnapshot("./__golden__/seo-meta.component.json");
});

it("Author schema.json (with synthesized inverse) matches the golden", async () => {
  const result = strapiAdapter.generate(roundTrip, { projectName: "blog" });
  const author = result.files.find((f) => f.path.endsWith("author/schema.json"))!.content;
  await expect(author).toMatchFileSnapshot("./__golden__/author.schema.json");
});
```

- [ ] **Step 3: Run once to generate the new goldens, INSPECT them, re-run**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/golden.test.ts src/import/import-document.test.ts`
Open `__golden__/seo-meta.component.json` (confirm `collectionName: "components_shared_seo_metas"`, `info.displayName: "Seo Meta"`, `attributes.metaTitle`) and `__golden__/author.schema.json` (confirm the `articles` attribute = `{ type:"relation", relation:"oneToMany", target:"api::article.article", mappedBy:"author" }`). If wrong, fix the generator, delete the golden, rerun. Then re-run to confirm byte-stable.

- [ ] **Step 4: Confirm PASS**

Run: `pnpm --filter @camis/adapter-strapi exec vitest run src/golden.test.ts src/import/import-document.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (incl. goldens)**

```bash
git add packages/adapter-strapi
git commit -m "test(adapter-strapi): import gap + component/inverse goldens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 14: full sweep + boundary/docs check

**Files:** none (verification) unless a fix is needed.

- [ ] **Step 1: Full sweep**

Run, expecting all green (report counts):
```bash
pnpm lint
pnpm -r typecheck
pnpm -r test
```

- [ ] **Step 2: Confirm import reads only declarative sources**

Grep the import code to confirm it never reads `.ts`/controllers/routes/services:
Run: `grep -rn "controllers\|routes\|services\|\.ts" packages/adapter-strapi/src/import/`
Expected: no matches that READ generated code (only the path filters for `schema.json`/component json). If `read-project.ts` or `import-document.ts` reads anything but `schema.json`/component json, fix it.

- [ ] **Step 3: Commit (only if a fix was made)**

```bash
git add packages/adapter-strapi
git commit -m "chore(adapter-strapi): Phase 3 verification fixes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(If no fix needed, skip the commit.)

---

## Self-review (completed by plan author)

**Spec coverage:** D1 components both directions (Tasks 2,4,5 generate; 8,9 import) · D2 pure importDocument + readStrapiProject (Tasks 10,11) · D3 curated round-trip exact equality (Task 12) · D4 reuse CapabilityGapReport (Tasks 7,10,13) · D5 shared category (Tasks 2,4) · D6 collection types only (Task 9 maps singleType but fixtures are collections) · D7 two-sided relations: generate synthesizes inverse (Tasks 3,5), import collapses mappedBy (Task 8) · D8 import declarative-only (Task 10 regex filter, Task 14 grep check) · D9 media multiple/allowedTypes (Tasks 1 generate, 7 import) · D10 gaps vs validation Result + document-ordered gaps (Tasks 9,10,13). Round-trip spine (Task 12); readStrapiProject round-trip (Task 11); new goldens (Task 13). Exit criteria: round-trip green for content types/fields/relations/components (Task 12); unsupported reported (Tasks 7,13); full sweep (Task 14).

**Placeholder scan:** none — all code/commands concrete. The only judgement step is Task 12 debug (the round-trip), which is the intended TDD discovery point with concrete guidance.

**Type consistency:** `IrFieldResult { field?, gap?, skip? }` (Task 7) used by `schema.ts` (Task 9); `irName` (Task 6) used in Tasks 8,9,10; `synthesizedInverses`/`dual` (Task 3) used in `generate.ts` (Task 5); `contentTypeSchema(ct, extraAttributes?)` (Task 5) consumed by `generate.ts`; `importDocument` (Task 10) consumed by `read-project.ts` (Task 11) and round-trip (Task 12). `CapabilityGap`/`Result`/`IrDocument` from `@camis/ir-schema`, `normalize`/`validate` from `@camis/ir-core`, `stableJson`/`materialize` from `@camis/adapter-kernel` used consistently.
