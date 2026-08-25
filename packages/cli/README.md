# @camis/cli

`camis` — build CMS targets from a neutral content model (the IR).

## Commands

- `camis validate <ir.json>` — validate an IR document against the schema + invariants.
- `camis import <strapi|express> <projectDir> [--out ir.json]` — import a **declarative** source
  (a Strapi project's `schema.json`, or an Express project's `camis.schema.json`) into IR.
  Filament is generate-only (no importer).
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

Ownership conditions: owning relations (`manyToOne`/`oneToOne`) expose their FK to Ring-1
conditions as `record.<name>Id`, so a grant condition like
`{"kind":"eq","left":{"kind":"var","name":"record.ownerId"},"right":{"kind":"var","name":"user.id"}}`
enforces record-level ownership on both PHP and Express backends (fail-closed).
