# Phase 17 (Strapi storage layout) — follow-ups

Deferred findings from the per-task and whole-branch reviews of
`docs/superpowers/specs/2026-09-08-strapi-storage-layout-design.md` (spec in the oyl repo), as of
the branch head after the cross-check gate went green (2026-09-09). Everything Critical/Important
was fixed on the branch; these are the Minor items and the deliberate deferrals, grouped by where
the fix belongs. None blocks merge.

## Wire-contract changes to Phase 16 (not a follow-up — already landed)

The cross-check compared the same row read through both backends and found two Phase 16 wire forms
that did not match Strapi's. Both were corrected on the PHP side rather than papered over, so
`apiStyle: "strapi"` on **either** storage layout now serves:

- a datetime as `2026-09-08T10:00:00.000Z` — `toIso8601ZuluString('millisecond')`, three
  fractional digits as Strapi and JavaScript send it, where Carbon's `toJSON()` emitted six;
- a `bigInteger` as a JSON string (`"1250"`) rather than a JSON number, because a 64-bit value
  does not survive a JSON number.

**A Phase 16 deployment generated before this change serves the new forms after a regeneration**,
so a client that parses either type strictly may need updating. Every other golden in the repo is
byte-identical. Recorded in `docs/PLAN.md`'s Phase 17 exit criteria and in `packages/cli/README.md`
under `apiStyle`.

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
- ~~**`session()` does not fail fast on an empty `jwt_secret`**~~ — **fixed.** It now throws
  `RuntimeException('camis.jwt_secret must be set (>= 32 bytes) — see DEPLOY.md')` before
  `JWT::encode`, so a short or unset secret names itself instead of surfacing as a blanket 401 on
  every later request. The *verify* side (`StrapiJwtGuard`) still has no such guard. (Task 10
  review.)
- **A missing `up_roles` row during login renders Laravel's generic 404** instead of a Strapi-style
  error body; worth a comment or a follow-up fix once the exact 404 shape matters to a client.
  (Task 10 review.)
- ~~**`date`/`time` field storage is unverified against a live Strapi database**~~ — **verified,
  and the cast removed.** The storage model used to carry Laravel's `'date'` cast, which writes
  `Y-m-d H:i:s` into a column Strapi fills with a bare `Y-m-d`; spec 17i wants both types to pass
  through as strings, so the model now emits no cast for either, the serializer reads a `date`
  straight through on this layout, and `StrapiComponents` no longer hydrates a component `date` to
  a Carbon. The cross-check writes a `date` through PHP and reads it back through Strapi. `time`
  still has no fixture of its own — only a unit test pinning that it stays uncast.
- **Component update replaces the whole component subtree, per top-level component field, on every
  update** — deliberate, for Strapi parity (Strapi has no partial-component-update concept); this
  differs from the Laravel storage layout, which flattens a component into per-scalar columns and
  updates them individually. Documented in `packages/cli/README.md`, not changed.

## Emitters / tests

- ~~**`phpString`/`phpBool` in `storage/model.ts` duplicate `fields.ts`'s `phpSingleQuoted`**~~ —
  **fixed.** `packages/adapter-filament/src/php-literal.ts` now owns `phpSingleQuoted` (and
  `sqlSingleQuoted`); all five copies import it, and four emitters that quoted nothing at all
  (`render-eloquent`, `storage/controller-storage`, `permissions/policy`, plus the raw name
  interpolations in `storage/model`) route their names through it. `phpBool` stays local — it is
  two characters of boolean, not an escape. (Tasks 7/8 review.)
- **A redundant `RelationField` cast appears in more than one emitter** (Tasks 7, 8, 9) — could be
  narrowed once the underlying type is refined upstream.
- **Missing tests/goldens**: no golden for a content type with no relation and no component, none
  for a plain `oneToOne` relation (Task 7); in `query-ast.ts`, no test for a numeric literal
  compared against a link column, no `oneToOne` test, no test for a collision between two
  `and`-joined link conditions (Task 8); no golden for the Laravel-layout `DEPLOY.md` alongside the
  Strapi one, and no golden asserting the generated file listing is sorted (Task 11). Storage
  goldens live under `packages/adapter-filament/src/__golden__/storage/` rather than beside their
  emitters — accepted as the convention new storage goldens should follow too (Task 10).
- ~~**The local `StorageLayout` type alias in `query-ast.ts`**~~ — **fixed.** It imports the
  kernel's type and re-exports it for `scope.ts`. (Task 8 review.)
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
- ~~**No test covers an explicitly empty `collectionName` on import**~~ — **fixed, and it was a
  bug.** `irContentType` wrote `collection: ""` when the schema omitted `collectionName`; the IR
  now constrains collection/group names to `^[a-z0-9][a-z0-9_-]*$`, which rejects that, and the
  importer omits the key instead (as `irComponent` already did). (Task 2 review.)
- **The `byName` map is built separately in `projectPermissions` and `projectApiRoles`** in
  `packages/adapter-strapi/src/permissions/project.ts` — both derive the same `Map` from
  `doc.contentTypes`; worth extracting once a third consumer needs it. (Task 3 review.)
- **A fixture literal is duplicated across two publish tests** in the permissions package. (Task 3
  review.)
- **No test for an empty roles/grants map**, **none for a relation-to-user target that is not the
  built-in `User`**, and **a missing component referenced by a content type is silently skipped**
  rather than reported as a gap. (Task 5 review.)
- **The IR now rejects a `collectionName` or component folder that is not a lowercase
  identifier** (`^[a-z0-9][a-z0-9_-]*$`), so `camis import strapi` fails loudly on a hand-written
  camelCase `collectionName` instead of importing it. Every fixture passes; an external project
  that hits it should rename the physical table (a bad physical name is worse than an import
  error). (Final review.)
- **The bootstrap's revocation `findMany` passes no `limit`.** Strapi's query engine does not
  paginate `findMany` today; add `limit: -1` if that ever changes, or revocation silently becomes
  partial (never destructive). (Final review.)
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
- **The 32-byte `JWT_SECRET` minimum is enforced when minting, not when verifying** — the storage
  `AuthController::session()` now throws a named error before signing, but `StrapiJwtGuard` still
  answers a plain 401 when the configured secret is too short to verify with. Closing that (or a
  boot-time check) would make every path say the same thing. (Divergence 8, Task 12.)
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
- **The 32-byte `JWT_SECRET` minimum is enforced on the minting path only** — see
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
