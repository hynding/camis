# camis

**CMS with integrated AI.** A pnpm + TypeScript monorepo that compiles a single,
vendor-neutral content model (the **IR**) into runnable CMS applications across multiple
backend targets — **Strapi v5**, **Laravel 12 + Filament**, **Express + Drizzle + React
admin**, and future targets — and imports declarative schemas from those targets back into
the IR.

## Start here

1. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — what the system is and why (the IR, the
   three rings of logic, permissions, AI, the monorepo layout).
2. [`docs/PLAN.md`](./docs/PLAN.md) — the phased, TDD-first build sequence.
3. [`CLAUDE.md`](./CLAUDE.md) — conventions, TDD rules, SoC boundaries, naming.

## The one-paragraph mental model

One neutral IR is the source of truth. Adapters generate target projects from it (one-way,
authoritative). Logic lives in three rings: **declarative data** (compiles everywhere),
**bounded pure expressions** (one grammar compiled to both PHP and TS, locked by
cross-runtime conformance vectors), and **behavioral hooks** (a typed contract you implement
by hand in each language — never transpiled). Permissions use a superset model that
down-projects per target, compiling on the PHP path to `spatie/laravel-permission` plus
generated Laravel Policies. AI is both an authoring-time IR producer and a runtime IR
primitive.

## Layout

- `packages/` — the product: IR, expression engine, permission model, target adapters, AI, CLI.
- `apps/` — generated, runnable CMS projects (disposable outputs).
- `vendor/` — vendored/patched third-party code.
- `docs/` — architecture and plan.

## Status

Greenfield. Build proceeds by the phases in [`docs/PLAN.md`](./docs/PLAN.md); each phase has
objective exit criteria and must be green before the next begins.
