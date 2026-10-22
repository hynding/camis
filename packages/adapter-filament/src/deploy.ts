import type { GeneratedFile, StorageLayout } from "@camis/adapter-kernel";

/**
 * The paragraphs that differ per storage layout: what the overlay contains, who owns the database
 * it points at, and what the first deploy actually runs. On the Strapi layout camis emits no
 * migrations and no seeder at all — Strapi's own boot creates and alters every table — so the
 * guide has to say where the schema comes from and how to check it, or an operator would look for
 * a `php artisan migrate` step that does not exist.
 */
const intro = (layout: StorageLayout): string =>
  layout === "strapi"
    ? `This directory is a standard Laravel 12 application with a camis-generated overlay
(models, JSON API controllers, policies) that reads and writes a **Strapi 5** database
directly. No migrations and no Filament admin panel are generated: Strapi owns the schema,
and Strapi's own admin panel owns content editing.`
    : `This directory is a standard Laravel 12 application with a camis-generated overlay
(models, migrations, Filament resources, policies). Deployment is stock Laravel.`;

const databaseIntro = (layout: StorageLayout): string =>
  layout === "strapi"
    ? `Point the connection at the same database the Strapi instance uses; no code changes between
environments.

Strapi owns the schema: boot Strapi against this database before the first deploy and after
each schema change; run \`php artisan camis:strapi-schema-check\` to verify every table and
column this app reads or writes is present.`
    : `Set the connection in \`.env\`; no code changes between environments.`;

const firstDeploy = (layout: StorageLayout): string =>
  layout === "strapi"
    ? `The generated JSON API in \`routes/api.php\` needs Laravel to route it: this layout has
\`camis scaffold filament --storage strapi\` add \`api: __DIR__.'/../routes/api.php'\` to
\`bootstrap/app.php\` rather than run Laravel's API installer, which would also install Sanctum
this layout does not use. Add that line by hand on an existing app. Custom endpoints belong in
\`routes/api-custom.php\` (never overwritten).

With the Strapi API style, \`camis scaffold filament\` also prepends the generated
\`StrapiErrors\` middleware to the \`api\` group in \`bootstrap/app.php\`; on an existing app add
\`$middleware->prependToGroup('api', \\App\\Http\\Middleware\\StrapiErrors::class);\` inside
\`->withMiddleware(...)\` by hand. \`routes/api.php\` does the same, but \`route:cache\` stops
Laravel reading route files, so without the bootstrap line a cached app loses Strapi's error
envelope.

Sessions are the JWT Strapi's users-permissions plugin issues, so \`JWT_SECRET\` must hold the
same HS256 secret as the Strapi instance — a session minted by either app is then accepted by
both. It must be **at least 32 bytes**: firebase/php-jwt rejects a shorter HMAC key, and because
that failure looks exactly like a bad token, every authenticated request would answer 401 with no
other clue. Strapi imposes no such minimum, so a secret that works there can still be too short
here. \`CAMIS_EMAIL_CONFIRMATION\` mirrors Strapi's "Enable email confirmation" advanced
setting, and \`CAMIS_AUTH_THROTTLE_PER_MINUTE\` (default 10, floored at 1) sets the request rate
allowed on \`/auth/local\` and \`/auth/local/register\` — one bucket per client address, shared
by both routes. The throttle is read through the generated \`config/camis.php\`; after changing
it re-run \`php artisan config:cache\`, and \`php artisan route:cache\` too if routes are cached —
the rate is baked into the cached route definition.

\`\`\`sh
composer install --no-dev --optimize-autoloader
php artisan key:generate
# Strapi created the schema; verify this app's view of it before serving traffic:
php artisan camis:strapi-schema-check
php artisan config:cache
php artisan route:cache
\`\`\``
    : `The generated JSON API in \`routes/api.php\` requires Laravel's API layer
(\`php artisan install:api\`) — \`camis scaffold filament\` runs it for you; add it manually on
an existing app. Custom endpoints belong in \`routes/api-custom.php\` (never overwritten).

With the Strapi API style, \`camis scaffold filament\` also prepends the generated
\`StrapiErrors\` middleware to the \`api\` group in \`bootstrap/app.php\`; on an existing app add
\`$middleware->prependToGroup('api', \\App\\Http\\Middleware\\StrapiErrors::class);\` inside
\`->withMiddleware(...)\` by hand. \`routes/api.php\` does the same, but \`route:cache\` stops
Laravel reading route files, so without the bootstrap line a cached app loses Strapi's error
envelope.

The Strapi API style adds a NOT NULL unique \`username\` column to \`users\`; run its migration
against an empty users table, or backfill usernames first. Two \`.env\` knobs govern its auth
endpoints: \`SANCTUM_TOKEN_EXPIRATION\` bounds token lifetime (tokens do not expire by default),
and \`CAMIS_AUTH_THROTTLE_PER_MINUTE\` (default 10, floored at 1) sets the request rate allowed
on \`/auth/local\` and \`/auth/local/register\` — one bucket per client address, shared by both
routes. The throttle is read through the generated \`config/camis.php\`; after changing it
re-run \`php artisan config:cache\`, and \`php artisan route:cache\` too if routes are cached —
the rate is baked into the cached route definition.

\`\`\`sh
composer install --no-dev --optimize-autoloader
php artisan key:generate
php artisan migrate
# only when roles were configured (database/seeders/RolePermissionSeeder.php exists):
php artisan db:seed --class=RolePermissionSeeder
php artisan filament:optimize
php artisan config:cache
php artisan route:cache
\`\`\``;

const offlineStep = (layout: StorageLayout): string =>
  layout === "strapi"
    ? `Run \`php artisan camis:strapi-schema-check\` via your host's one-off
job runner, or locally against the production database.`
    : `Run the migrate/seed steps via your host's one-off job runner, or
locally against the production database.`;

/** Strapi's GraphQL endpoint: its library, its route outside /api, and its parsed-schema cache. */
const graphqlSection = `

## GraphQL

\`/graphql\` serves Strapi 5's GraphQL content API through the same REST controllers, grants and
populate. It needs \`composer require webonyx/graphql-php:^15.19\` (\`camis scaffold filament
--graphql\` runs it), and \`bootstrap/app.php\` must load \`routes/graphql.php\` in \`withRouting\`'s
\`then:\` callback, inside the \`api\` middleware group (\`--graphql\` adds that too), so
\`route:cache\` keeps it. The first request parses \`graphql/schema.graphql\` into
\`bootstrap/cache/camis-graphql.php\`, which opcache then serves; it is rebuilt whenever the schema
changes, so that directory must stay writable, as Laravel's own caches need it to be.
\`CAMIS_GRAPHQL_DEFAULT_LIMIT\` (default 10) and \`CAMIS_GRAPHQL_MAX_LIMIT\` (default -1, no cap)
are Strapi's graphql \`defaultLimit\` and \`maxLimit\`.`;

/** Strapi's OpenAPI document and the Swagger UI page beside it, both static files. */
const documentationSection = `

## API documentation

\`/documentation\` is Swagger UI reading \`public/documentation/openapi.json\`, Strapi 5's OpenAPI 3.1
document for this API, written by \`camis build\` from the IR. Both are static files under
\`public/\`, so the web server sends them without starting PHP, and they change only when the
project is rebuilt. The page loads Swagger UI from jsDelivr, pinned to one release and checked
against its integrity hash. Anyone who can reach the site can read the document, as with
Strapi's documentation plugin by default; to keep it private, protect \`public/documentation/\`
in the web server (an \`.htaccess\` with basic auth on Apache) or build without
\`documentation\`.`;

/** Strapi's data import: moving a Strapi project's content, files and settings in. */
const transferSection = `

## Moving data in from Strapi

\`php artisan strapi:import --file=export.tar.gz\` reads an archive Strapi's \`strapi export\` wrote
(\`--no-encrypt\`; \`.tar\` or \`.tar.gz\`) and, as \`strapi import\` does, replaces this app's
content with it: every entry keeps its documentId, timestamps, components, links, draft and
published versions and locales, and the files' bytes go to the upload disk. \`--only\` and
\`--exclude\` take Strapi's \`content\`, \`files\` and \`config\`; \`--force\` skips the prompt. Users
are matched by email and keep their password hashes, so they sign in as before; accounts the
archive lacks, such as the admin's, are kept. A user's Strapi role becomes the camis role of the
same name, else the default one. Roles' permissions are not imported: the IR's grants are the
permissions. The import refuses an archive holding a content type or attribute this project
lacks, and names each one. On shared hosting without a shell, import locally against the
production database and upload the files under \`public/uploads\`.`;

/** What DEPLOY.md adds for the opt-in features this build includes. */
export interface DeployExtras {
  graphql?: boolean;
  documentation?: boolean;
  /** \`strapi:import\`: the Strapi API style over Laravel storage. */
  transfer?: boolean;
}

// Generator-owned deployment guide for the overlaid Laravel app. Regenerated on every run.
export const deployFile = (
  layout: StorageLayout = "laravel",
  { graphql = false, documentation = false, transfer = false }: DeployExtras = {},
): GeneratedFile => ({
  path: "DEPLOY.md",
  content: `<!-- @camis:generated — do not edit -->

# Deploying this camis-generated Filament app

${intro(layout)}

## Database — selected purely by environment

${databaseIntro(layout)}

\`\`\`ini
# sqlite (simplest; shared hosting friendly)
DB_CONNECTION=sqlite
# then: touch database/database.sqlite

# mysql
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=app
DB_USERNAME=app
DB_PASSWORD=secret

# pgsql
DB_CONNECTION=pgsql
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=app
DB_USERNAME=app
DB_PASSWORD=secret
\`\`\`

## First deploy

${firstDeploy(layout)}

${graphql ? graphqlSection.slice(2) + "\n\n" : ""}${documentation ? documentationSection.slice(2) + "\n\n" : ""}${transfer ? transferSection.slice(2) + "\n\n" : ""}## Shared hosting (no shell)

Build locally (scaffold + \`camis build\` + \`composer install\`), upload the whole app
directory, and point the document root at \`public/\`. Laravel's \`.htaccess\` ships in
\`public/\` for Apache. ${offlineStep(layout)}

## Regeneration

Generated files are overwritten on every \`camis build\`; hand-written code belongs in the
protected seams only (\`app/Hooks/*.php\` implementations and other seed-mode files).

## AI fields

If the IR declares AI fields, \`app/Ai/Provider.php\` is a stub that returns placeholder
text — replace it before production use.
`,
});
