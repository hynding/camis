# camis — Architecture

**camis** (CMS with integrated AI) is a monorepo that compiles a single, vendor-neutral
content model — the **IR** (Intermediate Representation) — into runnable CMS applications
across multiple backend targets (Strapi v5, Laravel 12 + Filament, Express + Drizzle, and
future targets), and supports importing declarative schemas from those targets back into
the IR.

This document describes *what the system is and why*. For the build sequence and task
breakdown, see [`PLAN.md`](./PLAN.md). For working conventions, see the root
[`CLAUDE.md`](../CLAUDE.md).

---

## 1. Design philosophy

### 1.1 The IR is the single source of truth

Everything flows from one neutral, JSON-serializable content model. Targets are *adapters*
that consume the IR and emit a project. The IR never contains target-specific concepts
(no Strapi `api::x.x` relation UIDs, no `__component` discriminators, no Filament Resource
classes). Those are adapter concerns.

```
                    ┌─────────────────────────┐
   import adapters  │                         │  generate adapters
  (declarative only)│          IR             │  (one-way, authoritative)
   Strapi schema ──▶│  (validated, neutral)   │──▶ Strapi v5 project
                    │                         │──▶ Laravel 12 + Filament
                    │                         │──▶ Express + Drizzle + React
                    └─────────────────────────┘──▶ (future targets)
```

"Vice-versa" (e.g. *Strapi → Filament*) is achieved **target → IR → target**, not by
reflecting generated code back into config. We import only from **declarative** sources
(a Strapi `schema.json` is data); we never parse generated PHP/TS code back into IR.

### 1.2 The three rings of logic

The hardest part of a multi-target CMS compiler is deciding how much *behavior* the
config can express. We draw three concentric rings and forbid any ring from leaking into
the one outside it.

| Ring | Contains | Compiled how | Example |
|------|----------|--------------|---------|
| **Ring 0 — Declarative data** | content types, fields, relations, options, permission *grants* | direct data → target serialization | "Article has a `title: string` and belongs to many `Tag`" |
| **Ring 1 — Bounded expressions** | validation rules, conditional field visibility, computed/derived values, permission *predicates* | compiled to PHP **and** TS from one shared grammar | "field `slug` is required when `status == 'published'`" |
| **Ring 2 — Behavioral logic** | loops, side effects, host/DB/API calls, anything non-pure | **not compiled**; a typed hook contract, implemented by hand in idiomatic PHP and TS | "on publish, call the translation service and fan out to N locales" |

**The cardinal rule:** Ring 1 is *closed and total* — a finite grammar of pure,
side-effect-free expressions (comparison, boolean logic, arithmetic, field references, a
fixed whitelist of pure functions). It can be exhaustively conformance-tested. The instant
a feature needs a loop, a side effect, or a host call, it belongs in Ring 2, where we write
two hand-authored implementations against a shared typed contract — *not* a transpiler.

This boundary is the project's spine. Ring 1's value is the guarantee that the same
expression produces the *same* result in PHP and TS. Ring 2's value is unrestricted power
without a second language runtime to keep in sync. Mixing them forfeits both guarantees.

### 1.3 Generated apps are hybrid artifacts

Generated code lives in clearly-marked regions the generator **owns and overwrites freely**
on every run. Ring 2 hooks and other bespoke code live in **protected directories the
generator never touches**. A manifest + file-header markers enforce the boundary. This is
the `prisma generate` / Rails-scaffold model: regenerate the derived layer safely; hand-own
the extension layer. Never hand-edit a generated region; the next regeneration will discard
your edits by design.

---

## 2. Monorepo layout

A pnpm + TypeScript workspace. Generated CMS projects are disposable outputs that live under
`generated/` (git-ignored, not workspace members); their Composer dependencies are owned and
driven inside each project directory (via the `camis` CLI), not through the pnpm workspace.

```
camis/
├── generated/                 # Generated, runnable CMS projects (git-ignored, disposable, not workspace members)
│   ├── <project>-strapi/
│   ├── <project>-filament/    # PHP app; Composer owned here, wrapped by package.json scripts
│   └── <project>-express/
├── apps/                      # Reserved for future management/UI applications (not generated outputs)
├── packages/                  # All buildable libraries (the actual product)
│   ├── ir-schema/             # IR type definitions + JSON Schema + validator
│   ├── ir-core/               # IR construction, normalization, invariants, capability model
│   ├── expr/                  # Ring 1: grammar, AST, the spec + canonical test vectors
│   ├── expr-ts/               # Ring 1: TypeScript evaluator (runtime) + TS emitter
│   ├── expr-php-emit/         # Ring 1: PHP code emitter (TS lib that emits PHP source)
│   ├── permissions/           # Neutral permission model + down-projection logic
│   ├── adapter-kernel/        # Shared adapter contracts, marker/manifest system, codegen utils
│   ├── adapter-strapi/        # Strapi v5 generate + import
│   ├── adapter-filament/      # Laravel 12 + Filament generate (Spatie + Policies)
│   ├── adapter-express/       # Express + Drizzle + React admin generate
│   ├── ai-authoring/          # Authoring-time AI: NL → validated IR mutations
│   ├── ai-runtime-spec/       # IR primitives for runtime AI features (neutral)
│   └── cli/                   # `camis` CLI: build / import / validate / generate
├── vendor/                    # Third-party code we vendor/patch (not pnpm-managed deps)
├── docs/
│   ├── ARCHITECTURE.md        # this file
│   └── PLAN.md
├── CLAUDE.md                  # conventions & guardrails for the build session
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

**Why `packages/` holds the product:** the generated projects are disposable outputs; the libraries are
the thing of value. Each package is independently testable and has one reason to change
(SoC). The PHP-emitter (`expr-php-emit`) is a *TypeScript* package that emits PHP *source*;
no PHP runtime is needed to build it, only to test the emitted output.

**The PHP package manager is Composer**, owned inside each generated Filament project under
`generated/`. There is no real alternative for the Laravel/Filament ecosystem, and
Filament/Spatie ship as Composer packages.

---

## 3. The IR

### 3.1 What it models

- **Content types** — collection types and single types; each has a name, fields, options
  (draft/publish, timestamps, soft-delete), and permission surface.
- **Fields (attributes)** — a neutral taxonomy adapted from Strapi's battle-tested set:
  `string`, `text`, `richText`, `enumeration`, `email`, `uid`, `integer`, `bigInteger`,
  `float`, `decimal`, `boolean`, `date`, `time`, `dateTime`, `timestamp`, `json`, `media`,
  `relation`, `component`, `dynamicZone`. Each field carries neutral constraints
  (required, unique, min/max, default, etc.).
- **Components** — reusable field groups, embeddable in types and dynamic zones.
- **Relations** — `oneToOne`, `oneToMany`, `manyToOne`, `manyToMany`, expressed
  neutrally (by IR type name, not by any target's UID format).
- **Permissions** — see §4.
- **Expressions (Ring 1)** — attached to fields/types as validation, visibility,
  computed values, or permission predicates.
- **Hooks (Ring 2)** — named, typed extension points with declared input/output shapes.
- **AI features** — neutral primitives (see §6).

### 3.2 We borrow Strapi's *taxonomy*, not its *serialization*

Strapi v5 is the maturity benchmark and the first import/export adapter, which conveniently
proves the IR can faithfully represent a real-world model. But the IR's own serialization is
clean and neutral; Strapi-isms are confined to `adapter-strapi`.

### 3.3 Capability model & gap reporting

Targets are not equally expressive. The IR carries a **capability descriptor** per target,
and generation produces a **capability-gap report**: any IR feature a target cannot represent
is surfaced loudly (error or explicit, acknowledged downgrade) rather than silently dropped.
The canonical example is permissions (§4).

---

## 4. Permissions — the hardest mapping

Permission models across targets **overlap but are not isomorphic**:

- **Strapi v5 RBAC** — roles → per-content-type, per-action grants, plus **field-level** and
  **condition-based** rules.
- **Spatie `laravel-permission`** (the engine under Filament Shield) — roles → flat,
  per-resource, per-action permission *keys*. Field-level and row/condition logic are **not**
  native; Filament's own guidance is to drop to **Laravel Policies** for anything richer.

### 4.1 The IR permission model is the superset

```
Role
 └── Grant (per content type)
      ├── actions: [create, read, update, delete, publish, …]
      ├── fieldRules?:   field → (read|write) gated by a Ring-1 predicate   (optional)
      └── conditionRule?: a Ring-1 predicate over the row/record/user        (optional)
```

### 4.2 Down-projection per target

| IR concept | Strapi adapter | Filament adapter |
|------------|----------------|------------------|
| role + per-type actions | native RBAC roles/permissions | **Spatie** roles + permission keys (the compile target — *not* Shield) |
| field-level rule | native field-level permission | **generated Laravel Policy** method body (Ring 1 → PHP) |
| condition rule | native condition | **generated Laravel Policy** method body (Ring 1 → PHP) |
| admin management UI | Strapi admin | **Shield is optional sugar** layered on top |

**Key decision: the Filament adapter compiles to `spatie/laravel-permission` + Laravel
Policies, *not* to Filament Shield.** Shield is a community plugin that recently underwent a
complete, non-backward-compatible rewrite and is explicitly not vetted by the Filament team;
coupling IR correctness to its conventions is a liability. Shield may be emitted *optionally*
as the admin management UI over the Spatie permissions we generate. This is also the clearest
reason Ring 1 must compile to PHP at all: field-level and condition rules become generated
Policy predicate bodies.

Anything a target genuinely cannot express appears in the capability-gap report.

---

## 5. Ring 1 — the bounded expression layer

### 5.1 One grammar, one spec, one set of test vectors

`packages/expr` owns:
- the expression **grammar** and **AST** types,
- a written **semantics spec** (truthiness, null handling, numeric coercion, function
  catalog — all pinned, no "implementation-defined" corners),
- a canonical **test-vector file**: `(expression, inputData) → expectedOutput` triples.

`packages/expr-ts` (TS evaluator + TS emitter) and `packages/expr-php-emit` (PHP emitter)
implement *against the same vectors*. CI runs every vector through both runtimes; any
divergence fails the build. This conformance suite is the contract that keeps PHP and TS
semantics identical — it is the single most important testing investment in the project.

### 5.2 Why not an off-the-shelf JSONLogic port

JSONLogic ports exist but their cross-language semantics are **not guaranteed identical**
(JS vs PHP differ subtly on coercion, truthiness, null). For permission predicates, those
subtleties are exactly the unacceptable bug class. We own the grammar so we own the
semantics. (We may *study* JSONLogic's operator set for inspiration; we do not depend on two
independently-evolved implementations matching.)

### 5.3 Scope guard

Ring 1 has **no** loops, **no** assignment, **no** side effects, **no** host calls. If a
requested feature needs any of those, it is a Ring 2 hook. Reviewers reject Ring-1 additions
that breach purity/totality.

---

## 6. AI ("the integrated AI in camis")

AI lives in **two** places, deliberately isolated behind interfaces.

### 6.1 Authoring-time AI (`ai-authoring`)

Natural language → **IR mutations** that are validated against the same IR schema as
everything else. The validator is the guardrail: the AI literally cannot emit an invalid
model — bad proposals fail validation and are rejected/repaired, never written. This keeps
AI a *producer of IR*, not a special path around it.

### 6.2 Runtime AI (`ai-runtime-spec`)

AI features inside generated apps are **first-class IR primitives** (e.g. an "AI field"
whose value is generated, or an "AI action" on a content type), which each adapter knows how
to emit for its target. Because camis = "CMS with integrated AI," runtime AI being a native
IR concept rather than a bolt-on is the core differentiator. The *spec* is neutral; each
adapter supplies the target-specific wiring.

---

## 7. Cross-cutting: testing, SoC, naming

- **TDD throughout.** Tests precede implementation. See `CLAUDE.md` for the red-green-refactor
  rule and coverage expectations.
- **Codegen is tested two ways:** golden-file/snapshot tests (IR fixture → emitted artifact,
  byte-compared) **and**, for Ring 1, cross-runtime conformance vectors (§5.1).
- **SoC:** each package has one responsibility and one reason to change. Adapters depend on
  `adapter-kernel` and the IR packages, never on each other.
- **Naming:** see `CLAUDE.md` §naming. Neutral IR vocabulary everywhere except inside the
  owning adapter.

---

## 8. Risks & mitigations (carried from design review)

| Risk | Mitigation |
|------|------------|
| Ring 1 grows into a second general-purpose language | Hard purity/totality guard; Ring 2 hook contract absorbs real behavior; reviewers enforce |
| PHP/TS expression semantics drift | Single grammar + shared conformance vectors run in both runtimes in CI |
| Permission models don't map cleanly | Superset IR model + per-target down-projection + capability-gap report; compile to Spatie+Policies, not Shield |
| Reverse-engineering generated code into IR | One-way authoritative; import only from declarative sources |
| Generated edits lost on regen | Marker/manifest system; protected directories for hand code; documented "never edit generated regions" |
| Scope sprawl across 5+ subsystems | PLAN sequences a single end-to-end vertical slice (Strapi, one content type) before any breadth |
| Coupling to churny community plugins | IR targets stable primitives (Spatie, Policies); Shield is optional |
