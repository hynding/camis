# @camis/cli

`camis` — build CMS targets from a neutral content model (the IR).

## Commands

- `camis new <dir>` — create a project, like `create-strapi-app`: writes `camis.json` (the IR),
  `roles.json` (Strapi's `public` and `authenticated` roles, `authenticated` as the default, plus
  `super-admin`, flagged `admin` with every action on every content type, since Strapi's own admin
  roles are not in its export; `php artisan camis:admin <email>` gives it to the first admin),
  `camis.config.json`, an empty `protected/`, a `.gitignore` for `generated/`, and a README; then
  scaffolds the Laravel host app when a filament target is chosen and runs `camis build`. Refuses to
  run over a directory that already has `camis.json` or `camis.config.json`. Options:
  - `--template vanilla|example` — `vanilla` (default) starts with an empty content model;
    `example` is create-strapi-app's blog (Article, Author, Category, About, Global and the
    `shared` components), with public read access on every content type. Upstream's `blocks`
    dynamic zones are left out because no target generates dynamic zones yet.
  - `--from-strapi <dir>` — import the content model from an existing Strapi or strapi-php
    project instead of a template, printing every attribute the importer had to drop.
  - `--targets strapi,filament,express` — default `strapi`. Each target is generated into
    `generated/<target>`; a filament target gets `apiStyle: "strapi"` so a Strapi client can use it.
  - `--dialect sqlite|mysql|pgsql` — the express target's database (default `sqlite`).
  - `--skip-scaffold`, `--skip-build` — write the project files only; the closing line names the
    commands left to run.
- `camis validate <ir.json>` — validate an IR document against the schema + invariants.
- `camis import <strapi|express> <projectDir> [--out ir.json] [--upsert-by <field>]` — import a
  **declarative** source (a Strapi project's `schema.json`, or an Express project's
  `camis.schema.json`) into IR, then lists any attribute it had to drop (dynamic zones, relations
  to plugin types other than the user). Filament is generate-only (no importer). Media
  `allowedTypes` map between Strapi's plural kinds (`images`) and the IR's singular (`image`).
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
- `camis develop [--config camis.config.json] [--no-serve]` — Strapi's `strapi develop`: build, then
  let the admin's Content-Type Builder edit the content model. Needs a filament target with
  `apiStyle: "strapi"` on the laravel storage layout; writes `CAMIS_PROJECT_CONFIG` and
  `CAMIS_BUILD_COMMAND` into its `.env`, runs `php artisan camis:schema-sync` and serves it with
  `php artisan serve`. With APP_ENV=local each save in the builder writes `camis.json` (and the
  super-admin's grants in `roles.json`), runs `camis build`, and syncs the database, keeping its
  rows; a build that fails puts both files back. Elsewhere the builder is read-only.

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
  content type owning a relation to the built-in user its grants do not `assign` additionally gets
  `users-permissions.user.find` — Strapi validates a relation write against the target's `find`
  scope, so without it the write is rejected; this is reported as a `userRelationWrite` gap
  because it also exposes `GET /api/users`. The bootstrap revokes what camis no longer grants: its
  `api::` actions, and a `plugin::` action only when an earlier boot of the bootstrap created it
  (recorded per role in Strapi's core store, `strapi.store({ type: "plugin", name: "camis" })`,
  key `granted-plugin-actions`), never one Strapi or an administrator granted; a role type taken
  out of the IR loses every action camis granted it (the role itself stays). A database seeded by
  a camis version before that record existed keeps its `user.find` until it is removed by hand. A
  content type whose relation inverts onto the user
  also gets a generated `src/extensions/users-permissions/strapi-server.ts`, declaring the other
  side of that relation on the plugin's own content type.
  A grant's `condition` and `assign` are enforced on the Strapi content API by a generated
  controller over Strapi's core controller (`src/permissions/api-controller.ts`, deciding through
  `src/permissions/api-conditions.ts`) on every collection type a non-admin role holds under one;
  on every collection type that reaches such a type through a relation, an inverse, a localized
  type's `localizations`, a component, a dynamic zone or a media field; and on every collection
  type with a relation both sides declare into a type with rules. Enforced:

  - `find` is narrowed by the role's read condition in the query (`$and`-ed with the client's
    filters, so pages and counts hold only readable rows); `findOne` (404 when unreadable),
    `update` and `delete` (404 when unreadable, 403 when readable but not changeable) evaluate the
    Ring 1 condition on every stored row of the entry (each version and locale) first.
  - A restricted caller's delete may carry only `locale` and `status` query parameters (400
    otherwise): Strapi reads a delete's filters into the where that picks the rows it deletes, so a
    relation filter there would answer a guess. An update's `filters` are 400 too, so the check
    holds whatever Strapi does with them (5.48 ignores them). Every other request takes only the
    query parameters Strapi 5.48 documents, and a populate that reaches a conditioned type only
    the options it reads; anything
    else, `publicationFilter` and `hasPublishedVersion` included (they test for a version the
    caller may not read), is 400.
  - `create` evaluates the role's create condition on the fields sent, an omitted field read as its
    IR `default`; each assigned relation is set from the session user on create and dropped from an
    update body. A restricted caller's create or update whose `data` is not an object is 400.
  - A `populate` into a conditioned type, at any depth and in any form (`*`, strings, dotted paths,
    arrays, objects, components, dynamic zones and their `on` fragments, `localizations`), carries
    that type's read filter (`$and`-ed with any filter of the client's); a relation filter through
    one is narrowed the same way, each relation filter its own item of an `$and` so Strapi's merge
    of nested filters cannot drop one, and so are the filters of a component's populate and of a
    zone's `on` fragments; a sort through one (a populate's included) is refused with 400, since
    its join cannot carry a filter. Populating a file's `related` entries under any media field is
    refused with 400 (they may be entries of any type).
  - Refused with 400 for a restricted caller, as filters SQL could turn into an oracle or Strapi
    cannot run: a `$not` whose subtree crosses a relation into a conditioned type (SQL's NOT of an
    unknown is unknown, so an entry with a NULL owner would answer a guess), at the top level or in
    a populate; `$null` (or `$notNull: false`) on a relation into a conditioned type, which would
    count an unreadable entry as none; a relation filter mixing an operator with attributes, or
    with a second operator. A bare value, a list or a lone operator on a relation
    (`filters[note][$in][0]=5`) tests the related id, under the scope; `$notNull` asks for a
    readable entry; either operator's value is read as Strapi reads a boolean (`true`/`t`/`1`,
    `false`/`f`/`0`), anything else 400. A `$not` inside a relation's own filter, `$ne`, `$notIn`
    and `$null` on a related attribute, and `$or` are allowed: the scope stays in a positive `$and`
    there, beside `id IS NOT NULL`, so an entry with no link (which Strapi's LEFT JOIN gives an
    all-NULL row) answers as one linked to an entry the caller cannot read.
  - A write linking an entry of a conditioned type (document id, row id, `connect`, `set`, in
    components and zones) is 403 unless the caller may read every row of it. Where both sides
    declare the link, it shows on the other entry, so each entry it connects, disconnects or drops
    by replacement (`set`, a list, `null`, or any write of a to-one side) must be one the caller
    may update; a many-to-many link only one side declares needs read alone. Linking an entry
    whose other side holds one entry at most (a bidirectional oneToOne or oneToMany) takes it from
    its last holder, which must be one the caller may update when its type has rules.
  - A restricted caller's create or update body is first checked against the type's attributes at
    every depth (400 otherwise): no key but an attribute (top-level `documentId`, `locale`,
    `publishedAt`, `createdBy` are refused); a relation item is a row id, a documentId, or an object
    with one of `id`/`documentId` and only `locale`, `status` and `position` beside it (`__type` on
    a polymorphic item; a position may name its anchor's `locale` and `status`); a media item is a
    row id or `{ id }`; a component item holds its attributes and its own `id`; a zone item names
    one of the zone's components; `null` clears. So no `__pivot` reaches a join row (it overrode the
    linked ids, in releases before this one too), a to-one relation, a polymorphic relation to one
    and a single media field take one entry, and a `set` stands alone. Any `set` but `null` replaces
    the relation, one entry included, so every entry it drops is checked. The check covers every
    collection type camis serves, including each with a relation or media field that a restricted
    role or an open route writes (served for this alone, its reads and deletes stay Strapi's), and
    each such single type, whose update is checked over Strapi's own single type controller; the
    built-in user and the media library are served by their plugins, unchecked (a non-admin user
    write is an error; the upload API takes only its documented fields).
  - The upload API, once a role the rules restrict holds a file grant, read included (a generated
    `src/extensions/upload/strapi-server.ts` wraps the plugin's content API controller): `POST
    /api/upload` takes only `fileInfo`, `ref`, `refId` and `field` (any other body field, `path` and
    `folder` among them, or query parameter but `id`, is 400); `ref`, `refId` and `field` come
    together, single-valued, `refId` a row id (a documentId is 400), and attach only to a content
    type's own media field on an entry the caller may update (every row of it), else 403 before
    anything is stored: a component's uid, a nested or non-media field and an entry that does not
    exist are 403. Each upload records its uploader in a private `camisUploader` attribute (the
    content API's `createdBy` is never set for a users-permissions caller). `?id=` (replace or info
    update) and `DELETE /api/upload/files/:id` need update on every entry the file is attached to,
    or that the caller uploaded it (an uploader keeps its own file). An entry create or update
    linking a stored file through a media field (at any depth of components and zones) is 403 unless
    the caller uploaded it or may update an entry it is attached to; a media value other than a row
    id (`3`, `"3"`, `{ id: 3 }`, a list, `connect`/`set`) is 400. These link checks apply whenever a
    restricted role or an open action writes a media field, file grants or not; with no file grants
    there is no uploader record and only the entry rule applies. Listing and reading files (`GET
    /api/upload/files`, `/files/:id`) are the plugin's once a restricted caller's populate of a
    file's `related` entries is refused (400, in any form or depth): Strapi returns that polymorphic
    list whole when it can read none of its entries.
  - The role is the session's users-permissions role, the public role without a session; a role
    the IR does not grant the type, a session whose role was not loaded and an unknown strategy are
    refused. Admin roles and API tokens are not narrowed; an `auth: false` action serves its own
    type's rows to anyone, but its reach into a conditioned type is the public role's.

  The build fails (`error`) where it cannot enforce: `apiGrantCondition` for a read condition
  outside `eq`/`and`/`or` over `record.<field>`/`record.<relation>Id` vs a literal or
  `user.id`/`user.email`/`user.role`, an update/delete condition reading another variable, a create
  condition reading a relation the client writes, or a condition on a single type, the built-in user
  or the media library; `apiPolymorphicReach` when a non-admin role reads or writes a type with a
  polymorphic relation or inverse at any depth, conditions or not (Strapi leaves a polymorphic list
  untouched when it can read none of its entries), and for any `auth: false` action on a type with a
  polymorphic relation at any depth, whatever roles exist (with no roles at all the open routes are
  still enforced); `apiRelationReach` for a reach from the built-in user, from the media library (a
  role that reads files, whose `related` entries reach a type it reads under a condition) or from a
  single type a role reads or writes, and for a role that writes the built-in user or a single type
  whose relation both sides declare into a type it does not update outright (the plugin's or
  Strapi's own controller serves those), and for a restricted role, or an `auth: false` action, that
  writes a single type with a media field (Strapi's single type controller links any stored file
  id); `apiUserWrite` for a non-admin role that may create or update the built-in user
  (users-permissions sets any user's role and password from the body), whatever else it holds. The
  admin-panel copy of a non-admin role cannot read `record.*`, so there its condition denies every
  entry (`conditionContext`, downgrade). Not enforced: GraphQL (if added by hand) and a `protected/`
  file replacing a generated controller; a publish condition apart from update's; deleting an entry,
  which drops its links and so changes the entries at their other ends without asking for update on
  them. On MySQL a string comparison follows the column's collation, whose defaults ignore case (and
  mostly accents), so a list or populate filter may let through rows Ring 1 would deny (`user.email
  == "A@x"` matches `a@x`); entry checks run Ring 1 and are exact. Closing that needs a binary
  comparison (`BINARY col = ?` or a `_bin` collation on the columns), which Strapi's filter syntax
  cannot express. The enforcement is unit-tested against a fake of the Strapi surface it uses, and
  its scoped queries run on Strapi's own query engine over sqlite; the `strapi-enforcement-boot` CI
  job runs the ownership fixture against a real Strapi 5 on sqlite (list, entry, owner, `GET
  /api/users`, populate, filter, two relation filters, sort, connect, a file's related entries,
  taking a pinned tag, the refused `$not` and `$null` filters, a component's populate filter, a tag
  with no note answering as one with a hidden note, a delete or update filtered by a guess), not
  zones, locales, drafts, MySQL or Postgres; it also fails unless every content API route a role can
  reach is in `scripts/content-api-allowlist.json` with a reason.

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
- `camis import strapi <dir> --roles-from export.tar.gz.enc --key <key>` also writes the roles
  file (`--roles-out`, default `roles.json`) from a `strapi export` archive's users-permissions
  roles; `camis new --from-strapi <dir> --roles-from …` does the same for a new project. A role
  holding only part of a camis grant's Strapi actions is reported, not granted.
- `camis import strapi <dir>` also reads the project's `config/plugins`, `config/api` and
  `config/middlewares` (`.php` under `php`, `.ts`/`.js` under `node`) and writes `deployment.env` beside the IR (`--env-out` to
  move it): the Laravel `.env` lines that give the Filament app the REST and GraphQL page sizes,
  users-permissions' session settings and register fields, the project's upload provider (`aws-s3` → the
  `s3` disk, `cloudinary` → the `cloudinary` disk, via `CAMIS_UPLOAD_DISK`), email provider
  (`sendmail`, `nodemailer` and `sendgrid` → SMTP, `mailgun`, `amazon-ses` → `ses`), plus its
  default sender and reply-to, the sentry plugin's DSN (→ `SENTRY_LARAVEL_DSN`), and `strapi::cors`'s
  origin, methods, headers, exposed headers, max age and credentials (→ `CAMIS_CORS_*`, read by
  `config/cors.php`). Each `env()` the
  config reads stays a `${NAME}` reference, so no secret is copied; the Composer packages the
  chosen disk, mailer or error reporter needs are printed. A provider or option with no
  counterpart (an S3 `rootPath`, cloudinary `actionOptions`, a nodemailer `service`, sentry `init`
  hooks, a CORS origin computed per request, a middleware list without `strapi::cors`) is listed
  as a gap.

The Filament target also generates a JSON API: `routes/api.php` +
`app/Http/Controllers/Api/*ApiController.php` per content type (index/show/store/update/
destroy). `options.upsertBy: "<uniqueField>"` on a content type makes `store()` upsert via
that field. With roles configured, routes carry auth middleware and controllers authorize
against the generated policies. Hand-written endpoints (aggregates like a `/bootstrap`)
go in `routes/api-custom.php` — seed-mode, written once, never overwritten.

Ownership conditions: owning relations (`manyToOne`/`oneToOne`) expose their FK to Ring-1
conditions as `record.<name>Id`, so a grant condition like
`{"kind":"eq","left":{"kind":"var","name":"record.ownerId"},"right":{"kind":"var","name":"user.id"}}`
enforces record-level ownership on the PHP, Express and Strapi backends (fail-closed).
