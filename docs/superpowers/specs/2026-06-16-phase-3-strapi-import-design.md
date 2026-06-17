# Phase 3 — Strapi Import (Declarative Round-Trip) Design (`adapter-strapi`)

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 3
**Scope:** parse a Strapi v5 `schema.json` (declarative) back into validated IR, and prove
`import(generate(ir)) ≅ ir` for the supported feature subset. Also completes the deferred
component *generate* path so components round-trip.

---

## 1. Context & goal

Phase 3 locks the IR's neutrality before targets multiply: target → IR → target. We import
**only declarative sources** (Strapi `schema.json` + component json), never generated PHP/TS
code. The spine is a round-trip property test: an IR document, generated to a Strapi project
and imported back, normalizes to the same IR. Components are in scope (PLAN exit criteria),
which requires finishing the component *generate* path deferred in Phase 2.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Components are in scope** — add component support to BOTH generate (deferred from Phase 2) and import. dynamicZones stay deferred (reported as gaps). | PLAN Phase 3 round-trip must be green for components; the round-trip is incomplete without them. |
| D2 | **Pure core + thin fs loader.** `importDocument(files)` parses an in-memory file set → IR; `readStrapiProject(dir)` loads schema files off disk and calls it. | Mirrors the Phase 2 generate(pure)/materialize(fs) split; the round-trip test feeds `generate()`'s output files with no disk I/O. |
| D3 | **Curated round-trippable fixtures, exact normalized equality.** Round-trip tests use fixtures containing only features that survive a full round-trip; assert `normalize(import(generate(ir))) deep-equals normalize(ir)`. | Simple and unambiguous; no projection machinery that could mask failures. |
| D4 | **Reuse `CapabilityGapReport`** for import diagnostics (constructs the IR can't represent). | A generation gap and an import gap are both representability gaps; one vocabulary, DRY. |
| D5 | **Default component category `shared`** on generate (a Strapi-ism confined to the adapter). Components round-trip by **name**; the category is fixed. | The IR `Component` has no category; Strapi requires one. A fixed default keeps round-trip deterministic. |
| D6 | **Import imports collection types only** (matching Phase 2 generate). Single-type import deferred. | Keeps the round-trip symmetric with what generate produces today. |

## 3. Strapi v5 component format (researched via context7)

- A content-type references a component: `{ "type":"component", "repeatable":bool, "component":"<category>.<name>" }` (e.g. `restaurant.openinghours`).
- Components live in `src/components/<category>/<name>.json`, shape:
  `{ "collectionName":"components_<category>_<plural>", "info":{ "displayName":... }, "options":{}, "attributes":{...} }` (no `kind`).
- Dynamic zone: `{ "type":"dynamiczone", "components":["category.name", ...] }` — **deferred** (gap both directions).

## 4. Completing the component generate path (Phase 2 deferral)

- **`attributes.ts`**: add a `component` branch → `{ type:"component", repeatable, component:"shared.<kebab-name>" }` (the kebab helper already exists in `names.ts`). Add a `dynamicZone` guard: such fields are **not emitted**; `generate()` records a capability-gap instead.
- **`component-schema.ts`** (new): `componentSchema(component)` → the component json object:
  `{ collectionName:"components_shared_<plural>", info:{ displayName:<humanized name> }, options:{}, attributes: toAttributes(fields) }`, where `<plural>` is the snake plural of the component name.
- **`generate.ts`**: also emit, per IR component, `src/components/shared/<kebab-name>.json` =
  `stableJson(componentSchema(component))`. Component fields in content-types reference
  `shared.<kebab-name>`. dynamicZone fields contribute a capability-gap, not a file/attribute.

## 5. Import — pure core (`adapter-strapi/src/import/`)

- **`names.ts`** — `irName(strapiSingular: string): string` = PascalCase from kebab
  (`article`→`Article`, `blog-post`→`BlogPost`). Inverse of generate's `kebab`.
- **`attributes.ts`** — `irField(name: string, attr: Record<string,unknown>): { field?: Field; gap?: CapabilityGap }`, inverse of `toAttribute`:
  - casing back: `richtext→richText`, `biginteger→bigInteger`, `datetime→dateTime`; other scalar types 1:1.
  - `relation`: `target` `api::author.author` → IR `target` `Author` (PascalCase of singular), `relationKind` from `relation`, `inverse` from `inversedBy`.
  - `component`: `shared.seo-meta` → IR `component` `SeoMeta` (PascalCase of name part), `repeatable`.
  - `enumeration`: `enum` → IR `values`; constraints (`required/unique/minLength/maxLength/min/max/default/targetField`) copied back when present.
  - unknown `type` (customField, plugin field, `dynamiczone`, etc.) → return a `gap` (`severity:"downgrade"`, located), no field.
- **`schema.ts`** — `irContentType(schema)` / `irComponent(componentName, schema)`: inverse of
  the generate builders.
  - Content type: `name` = `irName(info.singularName)` (authoritative declarative data in the
    schema); `names` = `{ display: info.displayName, plural: irName(info.pluralName), collection: collectionName }`; `kind` `collectionType→collection`; `options.draftPublish` from `options.draftAndPublish`; `fields` from `attributes` (insertion order preserved).
  - Component: its name is **NOT in the json body** — it comes from the **file path**
    (`src/components/shared/<name>.json` → `componentName = irName(<name>)`), which
    `import-document.ts` passes in. IR `Component` = `{ name: componentName, fields }`.
- **`import-document.ts`** — `importDocument(files: { path: string; content: string }[]): { document: Result<IrDocument>; gaps: CapabilityGapReport }`:
  classify files by path (`content-types/.../schema.json` vs `components/.../*.json`), parse each via `schema.ts`, assemble `{ version:1, contentTypes, components }`, collect field-level gaps, then **validate via `ir-core` `validate`** (returns the located errors if the reconstructed IR is somehow invalid).

## 6. Import — fs loader

- **`read-project.ts`** — `readStrapiProject(dir: string): Promise<{ document: Result<IrDocument>; gaps: CapabilityGapReport }>`: read `src/api/*/content-types/*/schema.json` and `src/components/*/*.json` under `dir`, build the `{ path, content }[]`, call `importDocument`. Thin; no parsing logic of its own.

## 7. Round-trip equality (the spine)

- **Curated fixtures** (`__fixtures__/`): standard PascalCase names; scalars + relations +
  components + draftPublish. **Excluded** (out of the round-trippable subset): softDelete
  (dropped to a gap on generate), timestamps (always-on in Strapi), acronym-heavy names
  (`APIKey` kebabs lossily), dynamicZone (deferred).
- **Assertion:** `normalize(importDocument(generate(ir, { projectName }).files).document.value)`
  **deep-equals** `normalize(ir)`.
- Symmetry: generate normalizes internally and emits `info`/`collectionName`; import
  reconstructs `name` + `names` from those, so a second `normalize` is a fixed point on both
  sides. Relation targets and component refs un-kebab to PascalCase deterministically.

## 8. Testing

- **Reverse-mapper unit tests**: `irName`, `irField` (each casing/relation/component/enum case;
  unknown type → gap).
- **Import unit tests**: a content-type `schema.json` fixture → expected IR ContentType; a
  component json → expected IR Component; a schema with an unknown attribute → a located gap.
- **Round-trip property tests**: each curated fixture survives `generate → importDocument` to a
  normalized-equal IR; gaps empty for the round-trippable subset.
- **Golden test**: the new component `schema.json` output, byte-exact (`__golden__/`).
- `readStrapiProject` test: materialize a generated project to a temp dir, read it back,
  assert the IR matches `importDocument` of the in-memory files.

## 9. Exit criteria (from PLAN.md Phase 3)

- Round-trip test green for **content types, fields, relations, components**.
- Unsupported constructs are **reported** (capability-gap), not silently dropped.
- `pnpm -r typecheck` / `pnpm -r test` / `pnpm lint` green; CI green.

## 10. Cross-cutting

- Import reads **only declarative** sources (`schema.json`, component json) — never generated
  controllers/routes/services or any code.
- All Strapi-isms (uid format, casing, `shared` category, `draftAndPublish`) stay confined to
  `adapter-strapi`; the import produces neutral IR validated by `ir-core`.
- Determinism: reverse mappers are pure and total over their supported inputs; round-trip
  equality is exact under normalization.
