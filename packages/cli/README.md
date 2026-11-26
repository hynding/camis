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

A field named as a target names its own keys or columns is such an error (`reservedFieldName`,
located at the content type or component and the field, before anything is written), since the
target would overwrite or refuse it. Names are compared as the target maps them, so
`published_at` and `PublishedAt` (an imported API key) are caught as `publishedAt` is. A relation's
inverse is located on the type it lands on, a built-in type's included. Where a target flattens a
non-repeatable component into the row holding it, its fields' columns are named by their path
(`created` holding `at` is `created_at`) and checked too, located at the content type, the
component and its field; where it stores a component's items as rows of a table of their own, an
item's fields are checked against that table's own columns, located at the component and its
field. A gap is reported only where the target emits the colliding column or key:

- `strapi`, and `filament` with `apiStyle: "strapi"`: `documentId`, `createdAt`, `updatedAt`,
  `publishedAt`, `createdBy`, `updatedBy`, `locale`, `localizations` (and `createdById`,
  `updatedById`), the API keys `__component` and `__contentType`, and any name starting with
  `strapi`, `_strapi` or `__strapi`, compared snake_cased; for a field, its API key, a relation's
  inverse and a component's field. The Filament target also checks a to-one relation's key column,
  so a relation named `document` (`document_id`) is refused there, and on the Laravel storage
  layout a one-to-many's key column on its target's rows, named by its inverse (an inverse
  `document`) or, without one, by the type holding it (a type `Document`), and a to-one
  polymorphic relation's `<name>_id` and `<name>_type`. Strapi's Content-Type Builder additionally
  refuses `status`, `meta` and `entry_id`; camis lets them through, since none is a key of an entry
  and Strapi reads and writes such a field as it should.
- `filament` with `apiStyle: "laravel"`: `createdAt` and `updatedAt`, whose columns are Laravel's
  timestamps.
- `filament` on the Laravel storage layout (either API style): an embedded component's columns on
  the entry's row, and an item's columns on its item table's rows, which keep the timestamps, the
  key to the row holding them (`note_id`, or `note_items_id` in a nested table) and, a dynamic zone
  member's on the Strapi API style, `position`. A media field inside a component is a column there
  unless the project keeps a media library.
- `express`: `createdAt` and `updatedAt` on a content type, a built-in one included, and an
  embedded component's columns on the entry's table; an item's columns on its item table, whose
  rows keep the key to their entry (`note_id`).

`id` is refused by `camis validate` itself, since every target keeps it.

A `decimal` may state its digits, `precision` (all of them, 1 to 65) and `scale` (those after the
point, 0 to 30 and at most the precision), both or neither: `camis validate` refuses one without
the other, or out of bounds, and a `default`, `min` or `max` with more digits before the point than
`precision - scale`, or a `default` with more after it than `scale` (`invalid_decimal_digits`,
located at the key), MySQL's DECIMAL being the narrowest database every target runs on. Without
digits each target keeps its own default, as before: (8, 2) on Filament, Strapi's (10, 2),
Drizzle's `decimal`/`numeric` on Express. With them:

- `filament`: `$table->decimal('x', p, s)`. PDO reads a SQLite decimal column as a PHP float, which
  becomes a string of 14 significant digits, so a decimal of 15 digits or more is DECIMAL on MySQL
  and PostgreSQL and text on SQLite (decided by the connection when it migrates). Every write of a
  model's attributes through Eloquent keeps a decimal stating its digits as MySQL and PostgreSQL
  keep it, whatever the database: its model's cast (`App\Casts\DecimalDigitsCast`, in place of
  `decimal:s`) takes a string or a JSON number of at most 100 characters (ASCII digits, one point,
  a sign, an exponent of at most three digits), trimmed, exponent form expanded, rounded half away
  from zero to the scale, stored with exactly the scale's digits after the point (so `1.5` and
  `1.50` are one value, also on SQLite's text) and read back as that string; a value that is not a
  decimal, or has more digits before the point than `precision - scale`, is refused. So are the
  APIs' writes (Strapi's 400 `ValidationError` on the Strapi API style, named by its full path,
  `entries[1].amount` inside a repeatable; Laravel's 422 validation errors on the Laravel API
  style), the admin's form (a text input with a validation rule, never a float, which checks a
  unique one as it is stored, rounded to the scale, as the Strapi API style's unique check does
  too) and the Strapi API style's archive import (which stops at a value that does not fit): every
  digit is kept on all three databases. The Laravel API
  style answers every decimal as a string, as it always has; the Strapi API style answers a decimal
  of 15 digits or more as a string (a JSON number of that many digits is rounded by every
  JavaScript client), over REST, GraphQL (`String`), the OpenAPI document and the MCP tools, and
  every other decimal as the number Strapi answers. Its filters, and the admin list's search,
  compare a decimal stating its digits with the filter's exact value, never through a float and
  never rounding it (bound as `DECIMAL(p, s)` on MySQL, `NUMERIC` on PostgreSQL, text on SQLite; a
  value with more digits after the point than the scale equals nothing and orders by its nearest
  neighbours). Send an exact value as a string: a JSON number is a double by the time PHP reads it,
  so the digits a double does not keep are gone before the API sees them. On the Strapi API style a
  decimal of 15 digits or more on SQLite matches equal values exactly in a filter, but an ordering
  comparison (`$lt`, `$lte`, `$gt`, `$gte`, `$between`) or a sort on it compares text, the admin
  list's number filters compare it through a float, and a data-transfer archive carries it as a
  number, as Strapi's do (a `decimalPrecision` downgrade gap, located at the type or component and
  the field); on Strapi's storage layout the column is Strapi's, which SQLite keeps as a double
  read back with 14 digits (the same gap). A write past the model's cast keeps no canonical form:
  `$model->increment()` or `decrement()`, an Eloquent or query-builder `update()`, and any other
  write through the query builder than the import.
- `strapi`: the attribute's column settings, `"column": { "type": "decimal", "args": [p, s] }`,
  which Strapi's database layer lays over the decimal(10, 2) it makes. Strapi itself reads and
  writes a decimal as a JavaScript number on every database, so a decimal of more than 15 digits
  is rounded to 15 significant digits: a `decimalPrecision` downgrade gap. The importer reads the
  digits back from these settings, and reports other column settings on a decimal
  (`decimalColumn`) rather than dropping them silently.
- `express`: `decimal('x', { precision, scale })` on MySQL, `numeric(...)` on PostgreSQL; SQLite
  takes no digits, so `numeric('x')`, or `text('x')` for a decimal of more than 15 digits, which a
  JavaScript number keeps. Drizzle answers such a decimal as a string on every database, and the
  generated admin shows and edits it as text (`TextField`, `TextInput`), not as a number that would
  round it. The generated list sorts rows in JavaScript, comparing such strings as text, and the
  JSON body parser reads a JSON number as a double, so send an exact value as a string: a
  `decimalPrecision` downgrade gap, located, says both.

### Text columns

A `text` field's column is sized by its `maxLength` at four bytes a character (MySQL's worst case,
utf8mb4): `text` up to 16,383 characters, `mediumText` up to 4,194,303, `longText` above that and for
a text with no bound, as Strapi's longtext is; rich text is always `longText`. SQLite and PostgreSQL
keep one text type, so only MySQL sees the difference. A bound above 1,073,741,823 characters is
more than any MySQL text holds: the column stays `longText` and a `textLength` downgrade gap says
so. `filament` (Laravel storage) and `express` on MySQL choose the column; Strapi's own columns are
always longtext.

A migration that has already run is not run again, so a database made before this keeps its old
`text` columns (65,535 bytes on MySQL). Widen one by hand:

```php
Schema::table('articles', fn (Blueprint $table) => $table->longText('body')->nullable()->change());
```

or `ALTER TABLE articles MODIFY body LONGTEXT NULL;` (Express too). On Express with MySQL, adding
or lowering a `maxLength` makes the next `drizzle-kit push` narrow the column (`MODIFY ... TEXT`),
which fails in strict mode or truncates what no longer fits: read the SQL it proposes before
applying it. The Content-Type Builder's `camis:schema-sync` reads a text column's size from the
live column on MySQL and MariaDB, not from what it recorded: it widens a column that is smaller than
the model declares, and never narrows one on its own. Where the model declares a smaller text size
than the column has, the sync reports `kept <table>.<column> as <type>` and leaves the column as it
is; narrow it yourself once you know no value is longer, for instance
`ALTER TABLE articles MODIFY body TEXT NULL;`, and the next sync stops reporting it and records the
size the column has (a later widening in the model is then made). SQLite and PostgreSQL keep one
text type, so the sync leaves the three sizes alone there. The live size is read only where the record is missing or a text type: MariaDB stores JSON as a
LONGTEXT, so a column recorded as `json` that the model turns into text is converted as any change
of type is, not taken for a text size. A column with no record whose live MariaDB type is really
JSON reads as a longText and is left alone, as any unrecorded column is. This guards the text sizes only; a change
of a text column to a string, or of a string's length, is made as before.

The `textLength` gap covers the column type only. It does not cover the limits of the server or the
request (MySQL's `max_allowed_packet`, PostgreSQL's and SQLite's own value limits, near 1 GB).

### String columns and maxLength

A `string`, `email` or `uid` without a `maxLength` keeps a 255-character string column. A bound up to
255 characters is a string column of that length; a longer one is the text column that holds it, at
four bytes a character, as a `text` field's is (`text`, `mediumText`, `longText`), because a VARCHAR's
whole length counts toward the 65,535 bytes a MySQL row may take. A unique string stays a string
column, which an index takes whole, capped at 768 characters (MySQL's 3,072-byte index key): a
longer unique bound is a `stringLength` downgrade gap, as is a bound past LONGTEXT. `filament`
migrates the same column on every database; `express` does on MySQL, makes a longer bound a `text`
on PostgreSQL and keeps `text` on SQLite; `strapi` writes the column as the attribute's column
settings (`"column": { "type": "text", "args": ["mediumtext"] }`), which Strapi lays over the
varchar(255) it makes for every string. On Filament's Strapi storage layout the column is the one
Strapi made: a bound past 255 is a `stringLength` gap there.

Every write path checks a `maxLength` in characters (Unicode code points, as PHP's `mb_strlen`
counts them): the Laravel API style answers 422 (Laravel's `max` rule), the Strapi API style 400 as
Strapi does, the Filament admin form shows the field's error, and the Express API answers 400
`{ "error": "<field> must be at most <n> characters" }`. Strapi itself counts UTF-16 code units, so
it refuses a value of emoji at half its bound. A database made before this keeps its string columns
until a migration changes them, for instance
`Schema::table('entries', fn (Blueprint $table) => $table->text('headline')->nullable()->change());`.
PostgreSQL refuses a unique value whose index entry passes about 2,700 bytes.

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
  - API tokens are known as Strapi 5.48 authenticates them (strategy `content-api-token`, the
    token's `type` in `ctx.state.auth.credentials`; anything else is 403). A full-access or
    read-only token passes unchanged: no row condition applies and it reads every type. Custom
    tokens are not supported on enforced routes: Strapi returns a polymorphic list whole when the
    token may read none of its entries, at any depth, so every route camis serves (entry
    controllers, single types, the upload API) refuses a custom token with 403. camis leaves some
    routes to Strapi, each for a reason: on `/api/users*` a custom token is subject to Strapi's
    polymorphic sanitizer behaviour (issue #111); a type camis does not serve where the rules
    restrict someone (a plain type with no link, media or polymorphic reach) is safe, as nothing
    polymorphic can be populated from it; `/api/i18n/locales` and the auth routes are safe, as they
    populate nothing polymorphic; and every route where the rules restrict no one gets no
    enforcement (issue #111). A populate through the built-in user is walked like any other (every
    built-in user type of the IR is one user), and on the paths the generated controllers walk (a
    served type's query and its populates through links of the reach graph) a nested populate, a
    sort through, or any filter on a relation Strapi adds that camis does not walk (the user's
    `role`, an admin's `createdBy` and `updatedBy`, named in the generated holders) is 400 for a
    restricted caller, whatever the filter's value (`role=3` and `role[$in]` included); filters on
    the entry's own fields and on known relations pass. Two paths stay Strapi's own behaviour (issue
    #113): a type linking to the user that camis does not serve, and a populatable relation that is
    no link of the graph; there a populate's filter through `role` can tell which role a user has.
    `*` beneath the user populates its inverses only, not `role`.

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
  default 404 shape. Login and registration are throttled per client IP, each in a bucket of its
  own (with the Strapi API style, so is each group of credential routes, refresh, password
  recovery and reset, confirmation and the provider callbacks, `GET /auth/local/callback` included,
  with sign-in and recovery counted per address and the name given (taken by the controller
  with the name it looks up, before the lookup) under a per-address
  `CAMIS_AUTH_ADDRESS_THROTTLE_PER_MINUTE`, a password change counted per account, only failed
  refreshes counted at `CAMIS_REFRESH_THROTTLE_PER_MINUTE`, and a 429 carries `Retry-After`); its rate comes from the generated `config/camis.php` and is
  overridable with
  `CAMIS_AUTH_THROTTLE_PER_MINUTE` in `.env` (default 10 requests per minute, floored at 1, so a
  typo cannot lock the endpoints out). CORS allows credentials only for origins listed in
  `CAMIS_CORS_ORIGIN`, never with `*`; the refresh cookie is refused cross-site and defaults to
  `Secure`, `SameSite=Strict` and `Path=/api/auth`. The generated `DEPLOY.md` lists every setting
  and what an upgrade changes. Tokens last as Strapi's settings say (`CAMIS_JWT_LIFESPAN`, 30
  days by default; `CAMIS_ACCESS_TOKEN_LIFESPAN` in refresh mode); Laravel's
  `SANCTUM_TOKEN_EXPIRATION` is not read, and `expiration` in `config/sanctum.php` stays null.
  `CAMIS_AUTH_HIDE_ACCOUNT_EXISTENCE` (on by default) keeps registration, the confirmation resend
  and sign-in from telling whether an account exists (fully with email confirmation on), auth
  writes take only JSON bodies (415 otherwise), and refresh-mode token answers add `expiresIn`.
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
