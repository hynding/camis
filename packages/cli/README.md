# @camis/cli

`camis` — build CMS targets from a neutral content model (the IR).

## Commands

- `camis validate <ir.json>` — validate an IR document against the schema + invariants.
- `camis import <strapi|express> <projectDir> [--out ir.json]` — import a **declarative** source
  (a Strapi project's `schema.json`, or an Express project's `camis.schema.json`) into IR.
  Filament is generate-only (no importer).
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
