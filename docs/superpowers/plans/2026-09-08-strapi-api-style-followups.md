# Phase 16 (Strapi-compatible API style) — follow-ups

Deferred findings from the per-task and whole-branch reviews of
`docs/superpowers/plans/2026-09-08-strapi-api-style.md`, as of the branch head after the
final fix wave (2026-09-08). Everything Critical/Important was fixed on the branch; these are
the Minor items and the deliberate deferrals, grouped by where the fix belongs. None blocks
merge.

## Generated app behavior (adapter-filament / strapi-api)

- **Emit `$request->validate()` from the wire shape** (required scalars → `data.<key>` rules).
  Until then, `StrapiErrors` maps every `QueryException` to `400 ValidationError`, which also
  mislabels operational database faults (connection refused, deadlock) as client errors. Narrow
  that arm when validation emission lands. (Spec "Error handling"; final review I2.)
- **Register the error renderable in `bootstrap/app.php`** (`->withExceptions()` or
  `->withMiddleware(fn ($m) => $m->prependToGroup('api', StrapiErrors::class))`) as a scaffold
  step, and drop the now-redundant `Route::middleware([StrapiErrors::class])` group attribute.
  The current `Route::prependMiddlewareToGroup('api', …)` in `routes/api.php` is correct but
  (a) is skipped under `php artisan route:cache` — unreachable today only because `/_health` is
  a Closure route — and (b) silently no-ops if a host renames the `api` middleware group.
  Doing this also envelopes unmatched `/api/*` 404s, which no route middleware can see.
- **Roles-free strapi-style app leaves `/users/me` unauthenticated** (`Route::middleware([])`
  guard, goldened in `routes.unsecured.api.php`); `AuthController::me` would dereference a null
  user. Either always guard the sanctum group or document that the strapi style expects roles.
- **`index()` is N+1 on repeatable-component children**; `shape.children` names the relations,
  so emit `->with([...])` in `scoped()`. Lists are also unpaginated by spec; note for later.
- **`update()` lets a client re-key its own row** (`record_id` is fillable and on the wire);
  pin `$m->{self::KEY} = $key` in the update branch too.
- **Explicit nulls cannot clear a field** — `fromWire` collapses absent and explicit null. Worth
  a README sentence, or a sentinel.
- **Serializer**: `NUMERIC_INT`/`NUMERIC_FLOAT`/`DATETIME`/`DATE_ONLY` sets are untyped
  (`ReadonlySet<FieldType>` would make a typo a compile error); child rows are not guarded
  with `is_array` per row (malformed payload → TypeError 500); leaves render before branches so
  components land after `createdAt`/`updatedAt`; `boolean` relies on the model cast rather than
  a serializer cast.
- **PSR-12 soft limit** exceeded on three emitted lines (`StrapiErrors.php`, one controller).
- **Query AST**: `orWhereNull` branch has no direct test; `and` node args never `toEqual`-asserted;
  nested closures always emit `use ($user)` even without a `userId` in the subtree; temporal
  field types are bucketed as string-comparable — exact on SQLite, relies on literal coercion
  on MySQL/Postgres (a mysql/pgsql conformance job would settle it); `renderEloquent` should
  document that `user` must be non-null.
- **`routes.api.php` uses a hand-written header** instead of `PHP_MARKER`.
- **`ControllerSpec.ct` is unused** by the controller emitter.
- **Redundant `use App\Models\User;`** inside `namespace App\Models` in generated models with a
  scope (plan defect; would be a compile fatal only for a non-builtin `User` content type).
- **`emitStrapiApi` recomputes `projectFilamentPermissions`** and `wireShape` re-runs
  `expandComponents`; pass the results from `generate.ts` instead.
- **`generate.ts`**: double `Map.get` with `!`; asymmetric `apiStyle === "laravel"` vs
  `if (strapi)` guards.

## CLI / permissions / kernel

- **`ParsedRolesFile` is not re-exported** from `@camis/permissions`.
- **`copyDir` failure is unhandled** (raw ENOENT instead of the CLI's `✗` convention), and the
  `protected` overlay is mirrored into every target's `out`.
- **`--upsert-by ""` is indistinguishable from the flag being absent**; the flag is shown on the
  generic `camis import` line though it is a no-op for `express`.
- **`import-document.ts` `(f as { unique?: boolean })`** cast could be an `in` guard;
  `cli/import.ts` duplicates the `ImportOptions` shape instead of importing it.
- **`validate.ts` recomputes the builtin-user set per grant**; no tests for `assign` on a
  `oneToOne` relation or pointed at a scalar field.
- **`ApiStyle` lives in the shared kernel's `GenerateOptions`** although it is
  filament-specific.
- **`install:api` silently no-ops without `ext-intl`** (Composer refuses Sanctum); the scaffold
  should verify Sanctum was installed the way it now verifies the `User` model patch.

## CI / smoke / docs

- **Smoke script**: fixed `/tmp/body`; `body()` = `sed -n 2p` truncates multi-line bodies; no
  per-assertion trace (`echo "ok: <name>"` would make the CI log auditable).
- **`overlay.ts` silently ignores unrecognized trailing argv.**
- **README**: the error-envelope coverage sentence is slightly under-inclusive after the
  middleware prepend (it now covers the whole `api` group); "otherwise `HttpError`" does not
  mention the 500 `InternalServerError` arm.
- **DEPLOY.md** carries the `username`-migration sentence for laravel-style apps too
  (conditionally worded, harmless).
- **`project.ts` `.read` suffix strip** deserves a comment on the key-format invariant.

## For the oyl side (spec Part 2)

- The roles generator must derive catalog **update/delete** grants from
  `record.creatorId == user.id`, not from the public-or-mine read condition — otherwise public
  catalog rows are world-writable (final review I9; the camis fixture and smoke now encode the
  correct split).
- The `username` migration assumes an empty `users` table; the first deploy runs it before any
  registration.
- Set `SANCTUM_TOKEN_EXPIRATION` in production; tokens do not expire by default.
