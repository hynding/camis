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
  downgrade gaps and skipped.

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
  Ring-1-backed policies on Filament, and the JWT/enforcement layer on Express.
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
  `HttpError`), and the error envelope applies to every `api/*` route including hand-written
  `routes/api-custom.php` routes. Each controller is a generated base under
  `app/Http/Controllers/Api/Generated/` plus a seed-mode subclass you may override.
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
