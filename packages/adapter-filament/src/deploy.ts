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
allowed on \`/auth/local\` and \`/auth/local/register\` — each route in a bucket of its own per
client address. The throttle is read through the generated \`config/camis.php\`; after changing
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
on \`/auth/local\` and \`/auth/local/register\` — each in a bucket of its own per client address
(with the Strapi API style, every credential route: see Sign-in sessions). It is read through the
generated \`config/camis.php\`; after changing it re-run \`php artisan config:cache\`. Without the
Strapi API style re-run \`php artisan route:cache\` too if routes are cached —
the rate is baked into the cached route definition; with it, the rates are read per request.

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

/** Who may sign in to the Filament admin (the Strapi storage layout serves Strapi's admin instead). */
const adminSection = `## Admin sign-in

The admin's accounts live in their own \`admin_users\` table, apart from the API's users, as
Strapi keeps them: the generated \`config/auth.php\` gives them the \`admin\` guard, which the
admin panel signs in on, and an API user never reaches the admin. Only an active account holding
a role the roles file marks \`"admin": true\` may sign in, and never a blocked one; a project
without roles lets every active account in. Make the first admin after seeding (the password is
asked for when \`--password\` is left out):

\`\`\`sh
php artisan camis:admin admin@example.com --name="Admin"
\`\`\`

On the Strapi API style, Settings › Admin users manages the rest, and
\`php artisan strapi:import-admins --database=<the Strapi database>\` brings a Strapi project's
admin accounts over with their passwords and admin roles. Bring the roles in first:
\`camis import strapi <project> --admin-roles-from <its .tmp/data.db>\` (or \`camis new
--from-strapi … --admin-roles-from …\`) adds Strapi's admin roles and their permissions to the
roles file, so each account finds its role once the app is rebuilt and seeded.

\`camis scaffold filament\` signs the panel in on that guard. An app scaffolded before admin
accounts were separate still signs its admins in as users: add \`->authGuard('admin')\` after
\`->login()\` in \`app/Providers/Filament/AdminPanelProvider.php\`, make each admin again with
\`camis:admin\`, then delete their old rows from \`users\`, where the API still lists them.

`;

const offlineStep = (layout: StorageLayout): string =>
  layout === "strapi"
    ? `Run \`php artisan camis:strapi-schema-check\` via your host's one-off
job runner, or locally against the production database.`
    : `Run the migrate/seed steps via your host's one-off job runner, or
locally against the production database.`;

/** strapi::cors as config/cors.php has it, and where it is stricter than Strapi. */
const corsSection = `

## CORS

\`config/cors.php\` is Strapi's \`strapi::cors\` with one deliberate difference: credentials
(cookies) are allowed only for origins listed in \`CAMIS_CORS_ORIGIN\`, never with \`*\`. With the
default \`*\` any origin is answered with \`Access-Control-Allow-Origin: *\` and no credentials,
which is all a client sending its token in the \`Authorization\` header needs. Strapi echoes any
origin with credentials instead, which lets any site read what a visitor's cookies buy.

| Variable | Default | Meaning |
| --- | --- | --- |
| \`CAMIS_CORS_ORIGIN\` | \`*\` | Comma-separated origins (\`https://app.example.com,https://admin.example.com\`); \`*\` is any origin, without credentials |
| \`CAMIS_CORS_CREDENTIALS\` | \`true\` | Allow credentials for the listed origins; never applied with \`*\` |
| \`CAMIS_CORS_HEADERS\` | \`Content-Type,Authorization,Origin,Accept,X-Requested-With,x-strapi-refresh-cookie\` | Request headers allowed; \`*\` allows any |
| \`CAMIS_CORS_EXPOSE\` | \`Retry-After\` | Response headers a browser lets the caller read, so a throttled client knows when to retry |
| \`CAMIS_CORS_METHODS\`, \`CAMIS_CORS_MAX_AGE\` | Strapi's | As in \`strapi::cors\` |

Re-run \`php artisan config:cache\` after changing them.`;

/** users-permissions' credential routes, its refresh cookie and what an upgrade changes. */
const sessionsSection = `

## Sign-in sessions

Every route that checks a password or a refresh token is throttled, each group of routes in a
bucket of its own so a flood of one never locks out another. A bucket counts per client address,
except a password change, which counts per account: a stolen access token gets no more guesses from
more addresses. The GraphQL mutations take turns of the same buckets as their REST routes. The
rates are read per request, so \`php artisan config:cache\` is enough after changing them.

| Group | Routes | Rate per minute |
| --- | --- | --- |
| sign-in | \`POST /auth/local\`, \`GET /auth/{provider}/callback\` (for \`/auth/local/callback\` Strapi's password login, which Strapi leaves unthrottled), GraphQL \`login\` | \`CAMIS_AUTH_THROTTLE_PER_MINUTE\` (10) |
| register | \`POST /auth/local/register\`, GraphQL \`register\` | the same |
| recovery | \`POST /auth/forgot-password\`, \`/auth/reset-password\`, their GraphQL mutations | the same |
| confirmation | \`POST /auth/send-email-confirmation\` | the same |
| provider | \`GET /connect/{provider}\` and its callback | the same |
| password-change | \`POST /auth/change-password\`, GraphQL \`changePassword\`, per account | the same |
| refresh | \`POST /auth/refresh\` | \`CAMIS_REFRESH_THROTTLE_PER_MINUTE\` (60) |

A throttled request answers 429 \`RateLimitError\` in Strapi's error envelope, over REST with
\`Retry-After\`. A rate of 0, or one that is not a number, means 1 per minute: a typo cannot turn
the throttle off, nor lock every client out.

The client address is the one the request comes from. Behind a reverse proxy or load balancer
that Laravel does not trust, every client has the proxy's address, shares its buckets with every
other client and is throttled with them, and the request's own origin reads \`http\`. The
generated app does not trust any proxy by itself, since which addresses to trust belongs to the
deployment: add \`$middleware->trustProxies(at: ['10.0.0.0/8']);\` (the proxy's addresses, or
\`'*'\` when only the proxy can reach the app) inside \`->withMiddleware(...)\` in
\`bootstrap/app.php\`.

With \`CAMIS_JWT_MANAGEMENT=refresh\` a client may keep its refresh token in an httpOnly cookie
rather than the response body: for every request with \`CAMIS_SESSIONS_HTTP_ONLY=true\`, or per
request with the \`x-strapi-refresh-cookie: httpOnly\` header. The body stays the default, as in
Strapi. The cookie is always HttpOnly, and stricter than Strapi's by default:

| Variable | Default | Meaning |
| --- | --- | --- |
| \`CAMIS_SESSIONS_COOKIE_SECURE\` | \`true\` | \`false\` is honoured only with \`APP_ENV=local\` (browsers accept a Secure cookie from \`http://localhost\`) |
| \`CAMIS_SESSIONS_COOKIE_SAME_SITE\` | \`strict\` | A frontend on another site (not the API's own domain or a subdomain of it) needs \`none\` |
| \`CAMIS_SESSIONS_COOKIE_PATH\` | \`/api/auth\` | Sent to every route under \`/api/auth\` (refresh and logout read it), and to no content route |
| \`CAMIS_SESSIONS_COOKIE_DOMAIN\`, \`CAMIS_SESSIONS_COOKIE_NAME\` | host only, \`strapi_up_refresh\` | As in Strapi |

The cookie lasts until its session's absolute expiry (\`CAMIS_MAX_REFRESH_TOKEN_LIFESPAN\`), not
just the browser session.

On \`/auth/refresh\` the cookie is the only credential, and a browser attaches it to a request any
site makes. It is taken only from a request whose \`Origin\` is this app's own (\`APP_URL\` or the
request's own scheme and host) or a CORS origin allowed credentials, or from a request with no
\`Origin\` that carries \`X-Requested-With\` or \`x-strapi-refresh-cookie\` (headers a page of
another site cannot send without a preflight CORS refuses). Anything else answers 403
\`ForbiddenError\`. A refresh token sent in the JSON body is unaffected. Behind a TLS-terminating
proxy, trust it as above so the request's own origin reads \`https\`.

### Upgrading

- A browser client on another origin that sends the refresh cookie needs its origin listed in
  \`CAMIS_CORS_ORIGIN\`: with \`*\` credentials are no longer allowed.
- A cookie refresh with neither an allowed \`Origin\` nor one of the two headers is refused:
  send \`x-strapi-refresh-cookie: httpOnly\` (Strapi's own header) or \`X-Requested-With\`.
- The cookie moved to \`Path=/api/auth\`, \`SameSite=Strict\`, \`Secure\` and a Max-Age. A cookie set
  before, at \`/\` for the browser session, stays until the browser closes; the new one is sent
  first and wins, but logout clears only the new path. A deployment served over plain HTTP outside
  local development must move to HTTPS, and a frontend on another site must set
  \`CAMIS_SESSIONS_COOKIE_SAME_SITE=none\`.
- \`/auth/refresh\`, \`/auth/change-password\` and \`GET /auth/{provider}/callback\` are now
  throttled, and each group of credential routes counts on its own: raise
  \`CAMIS_REFRESH_THROTTLE_PER_MINUTE\` or \`CAMIS_AUTH_THROTTLE_PER_MINUTE\` if many clients
  share one address, then re-run \`php artisan config:cache\`.
- Logout without \`scope\` or \`deviceId\` ends the session of the access token it is sent with,
  where it ended the refresh cookie's; it clears the cookie only when the cookie named a session it
  ended, so another tab's newer sign-in keeps its cookie.`;

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

\`php artisan strapi:import --file=export.tar.gz.enc --key=…\` reads an archive Strapi's
\`strapi export\` wrote (encrypted with \`--key\`, or \`.tar\` / \`.tar.gz\` from \`--no-encrypt\`) and,
as \`strapi import\` does, replaces this app's content with it: every entry keeps its documentId, timestamps, components, links, draft and
published versions and locales, and the files' bytes go to the upload disk. \`--only\` and
\`--exclude\` take Strapi's \`content\`, \`files\` and \`config\`; \`--force\` skips the prompt. Users
are matched by email and keep their password hashes, so they sign in as before; accounts the
archive lacks, such as the admin's, are kept. A user's Strapi role becomes the camis role of the
same name, else the default one. Roles' permissions are the IR's grants, so they are not written
here: \`camis import strapi <project> --roles-from export.tar.gz.enc --key=…\` turns the archive's
roles into the roles file, and this import names each role whose permissions differ from it. The import refuses an archive holding a content type or attribute this project
lacks, and names each one. On shared hosting without a shell, use Settings › Data transfer
(below).

An archive holds no API or transfer tokens, so \`php artisan strapi:import-tokens
--database=<Strapi's database> --encryption-key=…\` reads them from the Strapi project's database (a
SQLite file's path, or a URL such as \`mysql://user:password@host/database\`). With
\`API_TOKEN_SALT\` and \`TRANSFER_TOKEN_SALT\` set to the Strapi project's, every key its clients
hold keeps working; given its \`ENCRYPTION_KEY\`, the admin can show an API token's key again.

## Moving data out to Strapi

\`php artisan strapi:export --file=export --key=…\` writes the archive Strapi's \`strapi export\`
writes (\`export.tar.gz.enc\`; \`--no-encrypt\` and \`--no-compress\` drop a step), which
\`strapi import\` reads into a Strapi project generated from the same IR (\`camis build\` with the
Strapi target). It holds every entry with its documentId, timestamps, components, links, draft
and published versions and locales; the media library and its files' bytes; every account with
its password hash, including any Filament admin kept in the same table; the roles, each with
Strapi's default users-permissions actions and the IR's grants; and the users-permissions,
locale and webhook settings. \`--only\` and \`--exclude\` take \`content\`, \`files\` and \`config\`.

## Data transfer without a shell

Settings › Data transfer runs the same export and import from the admin, for whoever may change
accounts. An export downloads through a link that works for ten minutes and is removed once
sent. An import takes an uploaded archive, or one put in \`storage/app/private/strapi-transfer\`
by FTP when it is larger than the host accepts in an upload (PHP's \`upload_max_filesize\` and
\`post_max_size\`, and Livewire's 12 MB \`temporary_file_upload\` rule), and asks before replacing
the content. Both run inside one web request, so a large project needs a host that lets PHP run
past its \`max_execution_time\`; where it does not, run the commands locally against the
production database.

## Transfer tokens

Settings › Transfer Tokens makes Strapi's transfer tokens; set \`TRANSFER_TOKEN_SALT\` to the
Strapi project's own to keep its tokens' hashes (unset, the app key salts them). A token is shown
once. \`strapi transfer --to/--from\` reaches \`/admin/transfer/runner/*\` and is checked as Strapi
checks it, but the transfer itself needs a WebSocket server, which PHP under FPM cannot keep, so a
valid token is answered 501: move the data with \`strapi:export\` and \`strapi:import\` instead,
or from the Strapi project with strapi-plugin-camis, which pushes to \`/admin/transfer/push\` and
pulls from \`/admin/transfer/pull\` over plain HTTP with the same tokens.`;

/** What DEPLOY.md adds for the opt-in features this build includes. */
export interface DeployExtras {
  graphql?: boolean;
  documentation?: boolean;
  /** \`strapi:import\` and \`strapi:export\`: the Strapi API style over Laravel storage. */
  transfer?: boolean;
  /** The IR declares schedules (routes/schedule.php). */
  schedules?: boolean;
  /** Strapi's MCP server: the Strapi API style with roles, so admin tokens to sign in with. */
  mcp?: boolean;
  /** config/cors.php: the Strapi API style, on either storage layout. */
  cors?: boolean;
  /** users-permissions' sessions and credential routes: the Strapi API style over Laravel storage. */
  sessions?: boolean;
}

const mcpSection = `

## MCP server

Strapi's MCP server answers at \`POST /mcp\`, off until \`CAMIS_MCP_ENABLED=true\` (Strapi's
\`server.mcp.enabled\`). A client signs in with an admin token from Settings › Admin Tokens and
sees the Content Manager's and the Media Library's tools its permissions reach, never more than
the token's owner holds. Each request is answered on its own, so it needs no sticky sessions
behind a load balancer; set \`CAMIS_MCP_ENABLED\` before \`php artisan config:cache\`.`;

const schedulesSection = `

## Scheduled tasks

The IR's schedules (Strapi's cron tasks) are in \`routes/schedule.php\`, each running a
hand-written class in \`app/Hooks\`. They run only where something calls Laravel's scheduler
every minute; on a host with cron, add

\`\`\`cron
* * * * * cd /path/to/app && php artisan schedule:run >> /dev/null 2>&1
\`\`\`

Without it nothing else breaks: the tasks just do not run. \`php artisan schedule:list\` shows
them, and \`php artisan schedule:test\` runs one now. \`camis scaffold\` loads the file from
\`routes/console.php\`; on an app scaffolded before it did, add
\`if (is_file(__DIR__.'/schedule.php')) { require __DIR__.'/schedule.php'; }\` there.`;

// Generator-owned deployment guide for the overlaid Laravel app. Regenerated on every run.
export const deployFile = (
  layout: StorageLayout = "laravel",
  {
    graphql = false,
    documentation = false,
    transfer = false,
    schedules = false,
    mcp = false,
    cors = false,
    sessions = false,
  }: DeployExtras = {},
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

${layout === "strapi" ? "" : adminSection}${cors ? corsSection.slice(2) + "\n\n" : ""}${sessions ? sessionsSection.slice(2) + "\n\n" : ""}${graphql ? graphqlSection.slice(2) + "\n\n" : ""}${documentation ? documentationSection.slice(2) + "\n\n" : ""}${transfer ? transferSection.slice(2) + "\n\n" : ""}${schedules ? schedulesSection.slice(2) + "\n\n" : ""}${mcp ? mcpSection.slice(2) + "\n\n" : ""}## Shared hosting (no shell)

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
