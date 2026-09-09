# Phase 17 (Strapi storage layout) — follow-ups

Deferred findings from the per-task and whole-branch reviews of
`docs/superpowers/specs/2026-09-08-strapi-storage-layout-design.md` (spec in the oyl repo), as of
the branch head after the cross-check gate went green (2026-09-09). Everything Critical/Important
was fixed on the branch; these are the Minor items and the deliberate deferrals, grouped by where
the fix belongs. None blocks merge.

## Generated app behavior (adapter-filament / strapi-api / storage)

- **A component with no scalar fields cannot be inserted** — parked rather than fixed; no fixture
  exercises a scalar-less component today. (Task 6 review.)
- **Fractional `_ord` values are not covered by a test** — the ordering column only needs to be
  monotonic between siblings, but nothing pins that a fractional insert-between produces one.
  (Task 6 review.)
- **A couple of idempotency tests in the storage runtime assert nothing beyond "ran twice without
  throwing"** — worth tightening to assert the row set is unchanged. (Task 6 review.)
- **`index()` loads a content type's components before applying the view filter**, doing
  eager-load work that a filtered-out row then discards. (Task 9 review.)
- **`store()` probes for an existing key before calling `authorize()`**, which is an existence
  oracle: an unauthorized caller can distinguish "no such record" from "exists, forbidden" by
  timing/response shape. Matches Strapi's own upsert behavior, so parked rather than fixed.
  (Task 9 review.)
- **`$m->fresh()` can return `null`** if the row is deleted between write and reload; this
  nullability gap is pre-existing in the Laravel (non-strapi) storage layout too, not introduced
  by this phase — recorded here rather than fixed in either layout. (Task 9 review, confirmed
  against the Laravel layout.)
- **The serializer and a controller are never exercised together on one fixture** — Task 9's
  fixture covers the serializer and the controller separately; a combined fixture would catch a
  shape mismatch between the two that neither test alone would. (Task 9 review; flagged as
  something Task 11 needed to close and worth re-checking now that Task 11 has landed.)
- **`session()` (the JWT guard) does not fail fast on an empty `jwt_secret`** — the guard already
  refuses to verify a token signed with an empty secret, so this is an earlier, clearer error
  location rather than a correctness gap. (Task 10 review.)
- **A missing `up_roles` row during login renders Laravel's generic 404** instead of a Strapi-style
  error body; worth a comment or a follow-up fix once the exact 404 shape matters to a client.
  (Task 10 review.)
- **`date`/`time` field storage is unverified against a live Strapi database.** Both types pass
  through the storage layout as plain strings with no cast (only `dateTime`/`timestamp` get the
  `StrapiDateTime` cast, and `biginteger` gets its string-wire-form fix) — deliberate, since no
  crosscheck fixture exercises `date`/`time` yet. Confirm the wire form once such a fixture exists,
  the way divergence 9 (Task 12) settled `dateTime` and `biginteger`.
- **Component update replaces the whole component subtree, per top-level component field, on every
  update** — deliberate, for Strapi parity (Strapi has no partial-component-update concept); this
  differs from the Laravel storage layout, which flattens a component into per-scalar columns and
  updates them individually. Documented in `packages/cli/README.md`, not changed.

## Emitters / tests

- **`phpString`/`phpBool` in `storage/model.ts` duplicate `fields.ts`'s `phpSingleQuoted`** —
  worth consolidating into one shared PHP-literal helper. (Tasks 7/8 review.)
- **A redundant `RelationField` cast appears in more than one emitter** (Tasks 7, 8, 9) — could be
  narrowed once the underlying type is refined upstream.
- **Missing tests/goldens**: no golden for a content type with no relation and no component, none
  for a plain `oneToOne` relation (Task 7); in `query-ast.ts`, no test for a numeric literal
  compared against a link column, no `oneToOne` test, no test for a collision between two
  `and`-joined link conditions (Task 8); no golden for the Laravel-layout `DEPLOY.md` alongside the
  Strapi one, and no golden asserting the generated file listing is sorted (Task 11). Storage
  goldens live under `packages/adapter-filament/src/__golden__/storage/` rather than beside their
  emitters — accepted as the convention new storage goldens should follow too (Task 10).
- **The local `StorageLayout` type alias in `query-ast.ts` was parked instead of importing the
  kernel's own type** — Tasks 9 and 11 both import the kernel type directly; `query-ast.ts` should
  follow once it needs the same distinction elsewhere. (Task 8 review.)
- **The ~35-line per-content-type emit loop is duplicated between `strapi-api/emit.ts` (the
  Sanctum-backed API-only path from Phase 16) and `strapi-api/storage/emit.ts` (this phase's
  storage-owning path)** — deliberately not unified: the Phase 16 path is frozen (its goldens and
  behavior must not move as a side effect of storage-layout work), and the two loops build
  materially different file sets (one emits FK columns and Eloquent relations, the other emits
  link-table reads/writes). Revisit if a third layout needs a third near-identical loop.
- **"Filament target" wording in a field-type capability-gap message** reads oddly on the Strapi
  storage layout's own gaps, which are also reported through the Filament adapter package but
  don't touch Filament itself. (Task 11 review.)

## Strapi target (`adapter-strapi`)

- **`normalize()` does not default `Component.names`** — every consumer instead falls back with
  `??` at the read site; centralizing the default would remove that repetition. (Task 2 review.)
- **No test covers an explicitly empty `collectionName` on import** (as opposed to it being
  absent). (Task 2 review.)
- **The `byName` map is built separately in `projectPermissions` and `projectApiRoles`** in
  `packages/adapter-strapi/src/permissions/project.ts` — both derive the same `Map` from
  `doc.contentTypes`; worth extracting once a third consumer needs it. (Task 3 review.)
- **A fixture literal is duplicated across two publish tests** in the permissions package. (Task 3
  review.)
- **No test for an empty roles/grants map**, **none for a relation-to-user target that is not the
  built-in `User`**, and **a missing component referenced by a content type is silently skipped**
  rather than reported as a gap. (Task 5 review.)
- **Strapi warns at boot that `admin.secrets.encryptionKey` is missing** from the generated
  `config/admin.ts` (non-fatal; Strapi 5.48 boots anyway) — see "For the oyl side" below for the
  follow-up. (Task 12 "Observed Strapi behaviour".)

## CLI / cross-check (`packages/cli`)

- **`strapi-storage-crosscheck.ts`'s `main()` is one long function** — extracting its phases
  (provision Strapi, provision Laravel, cross-read/write assertions, teardown) into named steps
  would make the script's control flow easier to follow and re-test in isolation. (Task 12 review.)
- **No preflight check that the ports the script binds (1447 for Strapi, 8765 for the PHP dev
  server) are free before launching children** — a stale process holding either port currently
  fails the run with a raw "Address already in use" rather than a clear preflight error. (Task 12
  review; a leftover `php artisan serve` hit exactly this during the Task 12 run.)
- **The 32-byte `JWT_SECRET` minimum is documented (README, DEPLOY.md) but not enforced at
  runtime** — a shorter secret currently fails as an indistinguishable blanket 401 on every
  authenticated request instead of a clear boot-time or first-request error. A guard in
  `StrapiJwtGuard` (or a scaffold/deploy check) that fails fast with a named error would close
  this. (Divergence 8, Task 12.)
- **`storageLayout` is currently accepted (and ignored) on non-filament targets**, mirroring how
  `apiStyle` already behaves — deliberate parity, not a bug, but worth a validation error if a
  future target adds its own same-named option with different semantics. (Task 4 review.)
- **A duplicated step-type annotation exists in `scaffold.ts`**, and **`--storage` is silently
  ignored on every scaffold-adjacent command that isn't `scaffold filament`** rather than
  rejected. (Task 4 review.)

## Deliberate decisions (recorded here per Task 13's brief, not changed)

- **`roles.json` role names must equal the target Strapi database's `up_roles.type`.** There is no
  name → `type` mapping table; the Strapi storage layout looks a user's role up by joining
  `up_users_role_lnk` to `up_roles` and matching on `type`, so a roles file whose `name` differs
  from Strapi's `type` for the same role silently fails to match. (Task 9 ruling.)
- **`confirmed` is not a 401 cause for a bearer token.** Strapi's JWT strategy (and the emitted
  `StrapiJwtGuard`) checks only `blocked` when authenticating a request; `confirmed` is enforced
  once, at login (`POST /auth/local`), matching Strapi's own split between "can this token
  authenticate" and "can this identifier log in". (Task 6 ruling.)
- **Component updates replace the whole subtree per top-level component field**, not per scalar —
  see "Generated app behavior" above; recorded again here because Task 13's brief calls it out as
  a documented constraint in its own right.
- **`date`/`time` storage is unverified** — see "Generated app behavior" above.
- **The Phase 16 (`strapi-api/emit.ts`) and Phase 17 (`strapi-api/storage/emit.ts`) per-type emit
  loops stay duplicated rather than unified**, to keep the Phase 16 path frozen — see
  "Emitters / tests" above.
- **`$m->fresh()` nullability is unhandled in both storage layouts** (the Strapi one and the
  pre-existing Laravel one) — see "Generated app behavior" above; recorded as a shared, not
  strapi-specific, gap.
- **The 32-byte `JWT_SECRET` minimum is documented, not enforced at runtime** — see
  "CLI / cross-check" above.
- **Strapi's `admin.secrets.encryptionKey` warning in the generated `config/admin.ts` is left
  unset** — see "For the oyl side" below; non-fatal today, so left as a follow-up rather than
  fixed in this phase.
- **The cross-check script's port preflight and `main()` phase extraction are left for later** —
  see "CLI / cross-check" above.

## For the oyl side

- **`admin.secrets.encryptionKey` is unset in the generated Strapi `config/admin.ts`**, which logs
  a non-fatal boot warning twice. Set a real key (e.g. from an env var) before any admin-panel
  feature that encrypts stored values is used. (Task 12 "Observed Strapi behaviour".)
- **firebase/php-jwt requires an HMAC secret of at least 32 bytes.** The oyl `.env.example` and the
  DreamHost `JWT_SECRET` value must satisfy this even though Strapi itself imposes no such minimum
  — a secret that works against Strapi alone can still be too short for the PHP side once the
  storage layout is deployed. (Ledger note 109; divergence 8, Task 12.)
