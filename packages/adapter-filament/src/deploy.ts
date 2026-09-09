import type { GeneratedFile } from "@camis/adapter-kernel";

// Generator-owned deployment guide for the overlaid Laravel app. Regenerated on every run.
export const deployFile = (): GeneratedFile => ({
  path: "DEPLOY.md",
  content: `<!-- @camis:generated — do not edit -->

# Deploying this camis-generated Filament app

This directory is a standard Laravel 12 application with a camis-generated overlay
(models, migrations, Filament resources, policies). Deployment is stock Laravel.

## Database — selected purely by environment

Set the connection in \`.env\`; no code changes between environments.

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

The generated JSON API in \`routes/api.php\` requires Laravel's API layer
(\`php artisan install:api\`) — \`camis scaffold filament\` runs it for you; add it manually on
an existing app. Custom endpoints belong in \`routes/api-custom.php\` (never overwritten).

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
\`\`\`

## Shared hosting (no shell)

Build locally (scaffold + \`camis build\` + \`composer install\`), upload the whole app
directory, and point the document root at \`public/\`. Laravel's \`.htaccess\` ships in
\`public/\` for Apache. Run the migrate/seed steps via your host's one-off job runner, or
locally against the production database.

## Regeneration

Generated files are overwritten on every \`camis build\`; hand-written code belongs in the
protected seams only (\`app/Hooks/*.php\` implementations and other seed-mode files).

## AI fields

If the IR declares AI fields, \`app/Ai/Provider.php\` is a stub that returns placeholder
text — replace it before production use.
`,
});
