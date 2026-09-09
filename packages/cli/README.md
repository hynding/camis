# @camis/cli

`camis` — build CMS targets from a neutral content model (the IR).

## Commands

- `camis validate <ir.json>` — validate an IR document against the schema + invariants.
- `camis import <strapi|express> <projectDir> [--out ir.json] [--upsert-by <field>]` — import a
  **declarative** source (a Strapi project's `schema.json`, or an Express project's
  `camis.schema.json`) into IR. Filament is generate-only (no importer).
  Relations targeting `plugin::users-permissions.user` map to a synthesized `builtin: "user"`
  content type named `User` (each target resolves it to its native user model — Strapi's plugin
  user, Laravel's stock `App\Models\User`). Other `plugin::` relation targets are reported as
  downgrade gaps and skipped. The Strapi importer also records each component's `Component.names`
  (`collection`, its `collectionName`, and `group`, the folder it lives in); the Strapi target
  honors both on regeneration instead of defaulting them.

On the relational targets (Filament, Express), `component` fields generate real structure:
non-repeatable components flatten into prefixed embedded columns (`amount.minor` →
`amount_minor`), and repeatable components become child tables with a cascade FK — surfaced
in Filament as `Repeater::relationship()` forms. Relations or AI attachments inside
components, and repeatables nested inside repeatables, are reported as downgrade gaps.
- `camis scaffold filament <dir>` — create the Laravel 12 + Filament v5 + Spatie host app the
  overlay needs (`composer create-project`, `filament:install --panels`, Spatie install +
  `HasRoles` patch on `app/Models/User.php`). Refuses to run over an existing composer project.
  Requires `composer` and `php` (with Filament's `ext-intl`) on PATH. Point a filament target's
  `out` at the same directory afterwards and run `camis build`.
- `camis generate [--config camis.config.json]` — dry-run: list the files each target would emit, plus
  any capability gaps. Writes nothing.
- `camis build [--config camis.config.json]` — write the generated project(s) to each target's `out`.

Exit codes: `0` on success (capability *downgrades* are warnings); non-zero on a validation failure,
an unreadable/invalid config, an unknown command, or an `error`-severity capability gap.

## camis.config.json

```json
{
  "ir": "./camis.json",
  "targets": [
    { "target": "express", "dialect": "sqlite", "out": "./generated/api" },
    { "target": "strapi", "out": "./generated/cms", "projectName": "blog" },
    { "target": "filament", "out": "./generated/admin" }
  ]
}
```

- `ir` and each `out` resolve relative to the config file's directory.
- `target` is `express` | `strapi` | `filament`; `dialect` (`sqlite` | `mysql` | `pgsql`) is Express-only.
- `projectName` defaults to the `out` directory's basename.
- `roles` (optional) points at a JSON array of roles (`@camis/permissions` shape:
  `{ name, grants: [{ contentType, actions, condition?, fieldRules? }] }`). When present, the
  roles are cross-validated against the IR and drive permission emission: the Spatie seeder +
  Ring-1-backed policies on Filament, and the JWT/enforcement layer on Express. On the Strapi
  target, the generated bootstrap (`src/index.ts`) also grants users-permissions API actions per
  role from `src/permissions/api-roles.json`: the `public` role always gets
  `users-permissions.auth.register` and `.auth.callback`, and a role that creates or updates a
  content type owning a relation to the built-in user additionally gets
  `users-permissions.user.find` — Strapi validates a relation write against the target's `find`
  scope, so without it the write is rejected; this is reported as a `userRelationWrite` gap
  because it also exposes `GET /api/users`. A content type whose relation inverts onto the user
  also gets a generated `src/extensions/users-permissions/strapi-server.ts`, declaring the other
  side of that relation on the plugin's own content type.
- `protected` (optional) is a directory mirrored into every target's `out` after generation —
  the home for hand-written seams (`routes/api-custom.php`, protected controller subclasses,
  hook implementations) so the generated app itself can stay git-ignored.
- `apiStyle` (filament only): `laravel` (default) or `strapi`. The Strapi style makes the
  generated JSON API a drop-in for a Strapi 5 client: `{ data }` envelope and
  `{ error: { status, name, message } }` errors, camelCase keys with components re-nested,
  nulls omitted, kebab-plural paths (`/activity-sessions`), `PUT /<path>/{key}` upsert keyed
  by `options.upsertBy`, lists scoped by the read grant's condition (compiled to SQL for
  `eq`/`and`/`or`, per-record policy filtering otherwise), create-time FK fill from the grant's
  `assign: { owner: "user.id" }`, Sanctum-backed `/auth/local`, `/auth/local/register`,
  `/users/me`, and `/_health`. Error responses name errors by HTTP status (`ValidationError`
  400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, otherwise
  `HttpError`), and the error envelope applies to every route registered in `routes/api.php` or
  `routes/api-custom.php`; requests to unmatched paths under `/api` fall back to Laravel's
  default 404 shape. Login and registration share one throttle bucket per client IP; its rate
  comes from the generated `config/camis.php` and is overridable with
  `CAMIS_AUTH_THROTTLE_PER_MINUTE` in `.env` (default 10 requests per minute, floored at 1, so a
  typo cannot lock the endpoints out). Set `SANCTUM_TOKEN_EXPIRATION` in `.env` to bound token
  lifetime (tokens do not expire by default).
  Each controller is a generated base under
  `app/Http/Controllers/Api/Generated/` plus a seed-mode subclass you may override. The Strapi
  API style adds a NOT NULL unique `username` column to `users`; run its migration against an
  empty users table, or backfill usernames first.
  **Wire-contract change (a client may need updating):** the cross-backend check found two wire
  forms that did not match Strapi's, and both were corrected — a datetime is now
  `2026-09-08T10:00:00.000Z` (three fractional digits, as Strapi and JavaScript send it) rather
  than Carbon's six, and a `bigInteger` is now a JSON string (`"1250"`) rather than a JSON number,
  because a 64-bit value does not survive a JSON number. Both apply on either storage layout, so a
  deployment generated before this change serves the new forms after a regeneration.
- `storageLayout` (filament only): `laravel` (default) or `strapi`; `"strapi"` requires
  `apiStyle: "strapi"` and is rejected otherwise. On this layout Strapi owns the schema: boot
  Strapi against the database before the first deploy and after every schema change, and the
  generated app never migrates it. Emitted: models mapped onto Strapi's tables (owning relations
  through `_lnk` link tables, components through `_cmps` links and component tables), an owned
  `app/Models/User.php` and `UpRole` model reading `up_users`/`up_users_role_lnk`, the
  `StrapiRows`/`StrapiComponents`/`StrapiDateTime`/`StrapiJwtGuard` runtime, a JWT-backed
  `AuthController`, controllers/routes/policies, and a regenerated `camis:strapi-schema-check`
  artisan command that verifies every table and column the app reads or writes is present. Not
  emitted: content migrations, Filament resources, or a Spatie seeder — each reported as a
  capability gap, including a project-level `adminPanelNotEmitted` gap. Two `.env` knobs: `JWT_SECRET`
  must hold the same HS256 secret as the Strapi instance and be **at least 32 bytes** (firebase/php-jwt
  refuses a shorter HMAC key, and that failure looks exactly like a bad token, so every
  authenticated request would answer 401 with no other clue); `CAMIS_EMAIL_CONFIRMATION` mirrors
  Strapi's "Enable email confirmation" advanced setting and defaults off, so users are confirmed
  on registration. Role names in the roles file must equal the corresponding `up_roles.type`.
  `camis scaffold filament <dir> --storage strapi` builds a Laravel 12 app with
  `firebase/php-jwt` and `visus/cuid2` and no Filament, Spatie, or Sanctum, and registers
  `routes/api.php` in `bootstrap/app.php` (this layout skips `php artisan install:api`, which
  would also install Sanctum). Updating a component field on this layout replaces its whole
  subtree rather than flattening per scalar, matching Strapi's own update semantics. `date` and
  `time` fields pass through as plain strings; their exact storage form against a live Strapi
  database is not yet verified (only `dateTime`/`timestamp` and `biginteger` wire forms are).
- The roles file is either a bare `Role[]` or `{ "defaultRole": "<role>", "roles": [...] }`;
  `defaultRole` is assigned on `/auth/local/register`.
- `camis import strapi <dir> --upsert-by recordId` sets `options.upsertBy` on every imported
  type that has a unique field of that name, so the IR stays fully regenerable.

The Filament target also generates a JSON API: `routes/api.php` +
`app/Http/Controllers/Api/*ApiController.php` per content type (index/show/store/update/
destroy). `options.upsertBy: "<uniqueField>"` on a content type makes `store()` upsert via
that field. With roles configured, routes carry auth middleware and controllers authorize
against the generated policies. Hand-written endpoints (aggregates like a `/bootstrap`)
go in `routes/api-custom.php` — seed-mode, written once, never overwritten.

Ownership conditions: owning relations (`manyToOne`/`oneToOne`) expose their FK to Ring-1
conditions as `record.<name>Id`, so a grant condition like
`{"kind":"eq","left":{"kind":"var","name":"record.ownerId"},"right":{"kind":"var","name":"user.id"}}`
enforces record-level ownership on both PHP and Express backends (fail-closed).
