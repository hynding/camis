import {
  endpointGuardsTable,
  isGuardedEndpoint,
  type GeneratedFile,
  type StorageLayout,
} from "@camis/adapter-kernel";
import type { Endpoint } from "@camis/ir-schema";

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
\`->withMiddleware(...)\` by hand, with
\`$middleware->prependToPriorityList(\\Illuminate\\Routing\\Middleware\\ThrottleRequests::class, \\App\\Http\\Middleware\\StrapiJsonBody::class);\`
so a credential body refused as not JSON takes no throttle turn. \`routes/api.php\` prepends
\`StrapiErrors\` too, but \`route:cache\` stops
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
\`->withMiddleware(...)\` by hand, with
\`$middleware->prependToPriorityList(\\Illuminate\\Routing\\Middleware\\ThrottleRequests::class, \\App\\Http\\Middleware\\StrapiJsonBody::class);\`
so a credential body refused as not JSON takes no throttle turn. \`routes/api.php\` prepends
\`StrapiErrors\` too, but \`route:cache\` stops
Laravel reading route files, so without the bootstrap line a cached app loses Strapi's error
envelope.

The Strapi API style adds a NOT NULL unique \`username\` column to \`users\`; run its migration
against an empty users table, or backfill usernames first. Its tokens last as long as Strapi's
settings say, each set on the token itself: \`CAMIS_JWT_LIFESPAN\` seconds (default 2592000, 30
days; 0: no expiry) for the token sign-in returns by default (\`CAMIS_JWT_MANAGEMENT=legacy-support\`), and with \`CAMIS_JWT_MANAGEMENT=refresh\`
\`CAMIS_ACCESS_TOKEN_LIFESPAN\` seconds (default 600) for each access token, renewed through
\`/auth/refresh\` (see Sign-in sessions). Laravel's \`SANCTUM_TOKEN_EXPIRATION\` is not read:
leave \`expiration\` null in \`config/sanctum.php\`, since Sanctum applies it to every token by
age, on top of the token's own expiry, and so would cut those lifetimes short.
\`CAMIS_AUTH_THROTTLE_PER_MINUTE\` (default 10, floored at 1) sets the request rate allowed
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

The panel's sign-in checks one password hash whether or not the email names an account, so its
time tells no admin account apart; a stored hash the hasher cannot read fails as a wrong password
rather than a 500, Strapi's \`$2a$\` hashes match, and a matched password of another cost is stored
again at the configured one. The generated \`CamisAuthServiceProvider\` sets that up, and
\`camis scaffold filament\` registers it in \`bootstrap/providers.php\`. On an app scaffolded
before, add this line to that file's array, after the admin panel's provider; until then the panel
signs in as Laravel's own provider does:

\`\`\`php
    ...(class_exists(\\App\\Providers\\CamisAuthServiceProvider::class) ? [\\App\\Providers\\CamisAuthServiceProvider::class] : []),
\`\`\`

\`php artisan make:provider\` and \`php artisan make:filament-panel\` rewrite that file from its
evaluated array, which drops the line until the first build has emitted the provider (and lists it
plainly after one). \`camis build\` warns, with the line to add again, whenever the file no longer
lists the provider.

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
bucket of its own so a flood of one never locks out another. A sign-in, recovery mail or
confirmation mail counts per client address and the name it gives, so a guesser at one name, or
everyone else behind the same address, does not lock another account out.
A name counts with its case, width, accents and surrounding spaces folded out, and the turn is
taken before the account is looked up: whether it finds an account has no bearing on the throttle,
so the throttle tells a caller neither that an account exists nor which names are one account. A
guesser who tries many names gets a turn for each, among them
an account's username and email, or two names the database matches (its collation may ignore what
folding keeps), so the per-address ceiling is the bound:
\`CAMIS_AUTH_ADDRESS_THROTTLE_PER_MINUTE\` (default 50, never below the credential rate) turns a
minute across every name one address tries. A password change counts per account: a stolen access
token gets no more guesses from more addresses. Every other group counts per client address.
Only a refresh that fails is counted, and once its bucket is full only failures are refused: a page of
another site that fires refreshes from a visitor's browser never stops a refresh with a valid
token, but its refused requests are failures from the visitor's address, so the visitor's own
failing refresh (an expired or revoked token) may answer 429 rather than 401 until the bucket
empties. The GraphQL mutations take turns of the same buckets as their REST routes. The rates are read per request, so
\`php artisan config:cache\` is enough after changing them.

The throttles and the mail bound count in Laravel's cache, which must count atomically for parallel
requests not to share one turn: \`CACHE_STORE\` \`database\` (Laravel's default), \`redis\` or
\`memcached\` do; the \`file\` store does not count atomically, so do not use it for a deployment
taking parallel requests, and \`array\` keeps nothing between requests.

| Group | Routes | Rate per minute |
| --- | --- | --- |
| sign-in | \`POST /auth/local\`, \`GET /auth/local/callback\` (Strapi's password login, which Strapi leaves unthrottled), GraphQL \`login\`, per address and name given | \`CAMIS_AUTH_THROTTLE_PER_MINUTE\` (10) |
| register | \`POST /auth/local/register\`, GraphQL \`register\` | the same |
| recovery | \`POST /auth/forgot-password\`, GraphQL \`forgotPassword\`, per address and name given | the same |
| password-reset | \`POST /auth/reset-password\`, GraphQL \`resetPassword\` | the same |
| confirmation | \`POST /auth/send-email-confirmation\`, per address and name given | the same |
| provider | \`GET /connect/{provider}\` and its callback, \`GET /auth/{provider}/callback\` for another provider than \`local\` | the same |
| password-change | \`POST /auth/change-password\`, GraphQL \`changePassword\`, per account | the same |
| refresh | \`POST /auth/refresh\`, failures only | \`CAMIS_REFRESH_THROTTLE_PER_MINUTE\` (60) |

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

Every auth write (\`/auth/local\`, \`/auth/local/register\`, \`/auth/forgot-password\`,
\`/auth/reset-password\`, \`/auth/send-email-confirmation\`, \`/auth/refresh\`,
\`/auth/change-password\`, \`/auth/logout\`) and a GraphQL POST takes its body only as JSON: a
body whose \`Content-Type\` is not \`application/json\` or an \`application/*+json\` type answers
415 \`UnsupportedMediaTypeError\` in Strapi's error envelope, unread and uncounted. A text/plain
body or a form is what a page of another site can post with no CORS preflight; Strapi parses a
form, and it is refused here on purpose, whether its body is raw or PHP has already parsed it into
fields and files. A request with no body goes on as Strapi takes it. Laravel's priority sort runs
its own throttle ahead of route middleware it does not list, so \`camis scaffold\` adds
\`$middleware->prependToPriorityList(\\Illuminate\\Routing\\Middleware\\ThrottleRequests::class, \\App\\Http\\Middleware\\StrapiJsonBody::class);\`
beside the \`StrapiErrors\` line in \`bootstrap/app.php\`; on an app scaffolded before, add it by hand.

\`CAMIS_AUTH_HIDE_ACCOUNT_EXISTENCE\` (default \`true\`) keeps the auth routes from telling a
caller whether an account exists, where Strapi tells. With email confirmation on (the
users-permissions advanced setting), registration answers a new address and a registered one, or
a username already taken, alike: 200 \`{"email": ..., "sent": true}\`, after hashing the password
on both paths, and even when a concurrent registration takes the name first. The new address gets
its confirmation mail; a registered address, or the address given with a taken username, gets one
notice saying a registration was attempted with it, which names neither as taken
(\`account_emails\` in \`config/camis.php\`). A username is looked up as an address too, as Strapi
looks it up, so a username that is an email address other than the one registering is refused
with 400 \`ValidationError\` before any lookup. Over GraphQL, whose \`register\` payload must hold a
user, every such registration answers one error, \`ConfirmationPendingError\` (code
\`STRAPI_CONFIRMATION_PENDING_ERROR\`, "Check your email to finish registering").
\`/auth/send-email-confirmation\` answers every address \`{"email": ..., "sent": true}\` and mails
only an account that is neither confirmed nor blocked. Sign-in checks one password hash whether
or not an account matches, whatever the setting. Account mail (confirmation, recovery and these
notices) is sent after the answer, with no queue: under PHP-FPM or LiteSpeed the response is
finished first (\`fastcgi_finish_request\`), while under mod_php or \`php artisan serve\` the client
still waits for the mail, and its time shows. A mail that fails is logged, not answered. Each kind
of mail a caller can send to an address they name (the registration notice, the confirmation
resend, recovery) goes to one address at most \`CAMIS_ACCOUNT_MAIL_PER_HOUR\` times an hour
(default 3, floored at 1), whoever asks; a mail over the bound is skipped silently, so the answer
does not change. The bound weighs two costs: lower, it caps the unsolicited mail anyone can send
an address; but whoever spends an address's turns first, a stranger included, leaves its owner's
own request answered as sent, though no mail goes and the owner is told nothing until the hour is up.
The default burst of 3 leaves an owner a mail of their own unless someone is spending them on
purpose. A failure of the cache the bound counts in sends no mail.

A username containing "@", once folded (case, width and look-alikes such as a fullwidth "@"
removed), is read as an address, since the database's collation may read it as one: under MySQL's
\`utf8mb4_unicode_ci\` a fullwidth or small "@" compares equal to "@". Whether a name is taken is
still asked through that collation, so which names count as one depends on the database (SQLite
and PostgreSQL compare them as stored, MySQL ignores case, width and accents); the throttles fold
names whatever the database.

Without email confirmation registration cannot answer every address the same: a new account gets its token at
once, so a taken address or username still answers Strapi's 400 "Email or Username are already
taken". Turn confirmation on to hide it. What the setting leaves distinguishable: a new
registration's insert, a few milliseconds; the blocked and unconfirmed errors, which come only
after a correct password, as in Strapi; a person registering with their own address learns a
username is taken by getting the notice in place of a confirmation mail, which unique usernames make inherent; and an account whose stored hash has another cost, which
takes another time to check. Every account imported from Strapi is bcryptjs cost 10, so imported
accounts stay distinguishable by timing until their first sign-in, which stores the password again
at the configured cost. \`BCRYPT_ROUNDS=10\` closes that at once, at the price of hashing every new
password at cost 10 rather than Laravel's 12, a quarter of the work for anyone cracking a stolen
hash offline. \`false\` restores Strapi's answers (registration's \`{"user": ...}\`,
the resend's errors for a confirmed or blocked account) and sends mail inside the request.

Strapi's bcryptjs hashes (\`$2a$\`) are imported as PHP's (\`$2y$\`), and one stored by an earlier
import is read as PHP's at sign-in. A stored hash the configured hasher cannot verify fails as a
wrong password, logged for the operator, never a 500: changing \`HASH_DRIVER\` away from the driver
the stored hashes use makes every such account unable to sign in, answered as a wrong password,
until its password is reset.

In refresh mode every answer that issues an access token (sign-in, registration, refresh, password
change and reset) adds \`expiresIn\`, the seconds the token lasts (\`CAMIS_ACCESS_TOKEN_LIFESPAN\`), so
a client can renew it before it is refused. Strapi's answers have no such field; a legacy token's
answer is Strapi's own.

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
- A sign-in, recovery mail or confirmation mail counts per address and the name it gives, under
  the per-address \`CAMIS_AUTH_ADDRESS_THROTTLE_PER_MINUTE\`: raise it for an office or a
  carrier-grade NAT where many users sign in from one address. A password reset has a bucket of
  its own, no longer shared with recovery mails.
- A throttled request answers 429 with Strapi's error body, \`RateLimitError\` and
  "Too many requests, please try again later.", and \`Retry-After\`, where it answered Laravel's
  own 429 body.
- A username or email longer than 255 characters is refused on registration and on
  \`POST\`/\`PUT /users\`, and a sign-in identifier that long is refused unread, as a wrong one.
- A string field of the auth and \`/users\` routes given a number, boolean, null, array or
  object answers 400 \`ValidationError\` with yup's message, as Strapi's strict validation does,
  where a number was taken as its string and an array or object answered 500. \`POST /users\`
  takes a single role id.
- \`CAMIS_AUTH_HIDE_ACCOUNT_EXISTENCE\` is on by default. With email confirmation on, registration
  answers \`{"email": ..., "sent": true}\` for every address, where a new account answered
  \`{"user": ...}\` and a taken address or username answered 400 (it is now told by mail), and
  \`/auth/send-email-confirmation\` answers \`{"email": ..., "sent": true}\` for every address,
  where a confirmed or blocked account answered an error. A failed mail is logged where it
  answered "Error sending confirmation email". Set it to \`false\` for Strapi's answers.
- An auth write or a GraphQL POST whose body is not JSON answers
  415 \`UnsupportedMediaTypeError\`: a client posting a form or text/plain must send
  \`Content-Type: application/json\`.
- In refresh mode the answers that issue an access token add \`expiresIn\`.
- With accounts hidden, a username that is an email address other than the one registering is
  refused with 400 \`ValidationError\`; the notices for a taken address and a taken username are one
  (\`account_emails.registration_attempted\`), and over GraphQL a registration waiting on its email
  answers \`ConfirmationPendingError\`, where the account was made but the answer failed.
- Account mail to one address is bounded by \`CAMIS_ACCOUNT_MAIL_PER_HOUR\` (default 3) per kind.
- Strapi's \`POST /admin/login\` and the admin panel's sign-in check one password hash whether or
  not the email names an account; the panel's needs \`CamisAuthServiceProvider\` in
  \`bootstrap/providers.php\` (see Admin sign-in).
- Imported \`$2a$\` hashes sign in, a hash the hasher cannot verify answers as a wrong password
  instead of 500, and a sign-in stores a hash of another cost again at the configured one.
- Add \`$middleware->prependToPriorityList(\\Illuminate\\Routing\\Middleware\\ThrottleRequests::class, \\App\\Http\\Middleware\\StrapiJsonBody::class);\`
  to an app scaffolded before, beside the \`StrapiErrors\` line in \`bootstrap/app.php\`.
- An entry created or updated without a field the grant assigns (an \`owner\` taken from the
  session, say) is accepted, where a required one answered 400 "owner must be defined"; the
  body's value for a field the grant assigns is still never taken.
- \`PUT /users\` refuses a \`role\` that is not a single role id with 400 \`ValidationError\`, where
  \`true\` was taken as a role id.
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
  /** The served endpoints, whose declared guards their routes check (config/camis-endpoints.php). */
  endpoints?: Endpoint[];
}

// Where Laravel serves routes/api.php, which camis writes the endpoints into.
const LARAVEL_API_PREFIX = "/api";

/** The IR endpoints' declared guards, checked at their routes before their handlers run. */
const endpointGuardsSection = (guarded: Endpoint[]): string => `

## Endpoint guards

These endpoints' routes check the guards the IR declares before the hand-written handler runs, in
this order: a cross-origin preflight is answered; a caller over the throttle answers 429
\`RateLimitError\` with \`Retry-After\` (refused requests count too); a body whose \`Content-Type\`,
without its parameters, is not listed answers 415 \`UnsupportedMediaTypeError\`, as does a body
sent with no \`Content-Type\`; a body larger than the limit, by its \`Content-Length\` or by the
bytes actually sent, answers 413 \`PayloadTooLargeError\`. Laravel decodes a JSON body when it
receives the request, before any route runs, so for JSON the size limit keeps the body from the
handler, not from that decoding; PHP's \`post_max_size\` bounds it there.

${endpointGuardsTable(guarded, LARAVEL_API_PREFIX)}

A throttle's variable overrides its rate when it is a whole number in ASCII digits, floored at 1;
any other value keeps the declared rate (an empty one, \`1e3\`, a sign or words); re-run
\`php artisan config:cache\` after changing it. It counts per client address in Laravel's cache, an
IPv6 caller by its /64 (the block one subscriber is given), keyed by an HMAC of the address under
\`APP_KEY\`, so the cache holds no address; the cache store applies to it as well. Its windows
are fixed minutes, so a caller can make up to twice its rate across the turn of a window. Grouping
IPv6 by /64 puts callers who share one in a single count: those behind one NAT64, Teredo clients
of one relay, every host of a shared /64. The key is an HMAC under \`APP_KEY\`, so changing \`APP_KEY\`
starts every count afresh; with no \`APP_KEY\` the throttled routes answer 500.

The client address is the one Laravel reads from the request: behind a reverse proxy or load
balancer Laravel does not trust, every caller shares the proxy's address, and so one count, and
the throttle refuses them all together. Trust the proxy as Sign-in sessions says, with
\`$middleware->trustProxies(at: [...])\` in \`bootstrap/app.php\` naming the proxy's addresses;
trusting \`'*'\` while clients can reach the app directly lets each one name its own address in
\`X-Forwarded-For\`, and so pass the throttle.

A public endpoint asks no credentials and no role: its route runs the guards, then the handler,
which is its only authorization. On an endpoint that is not public, the route checks the caller's
credentials first, before any guard, then the guards, then the roles the IR lists (403), then the
handler. Every public endpoint's contract in \`app/Hooks/Contracts\`, guarded or not, now says
that its handler is its only authorization, so regenerating changes that generated file in an
existing project; the hand-written handler is not touched.

An endpoint with a cross-origin column (\`none\`: no request header beyond those always allowed)
answers browsers on any origin itself, without
credentials, refusals included, whatever \`CAMIS_CORS_ORIGIN\` says; its preflight allows its
method and exactly the listed headers. Laravel's CORS answers every other route as before, and must
be left off these routes, which \`camis scaffold\` does in \`bootstrap/app.php\`; on an app scaffolded
before, add inside \`->withMiddleware(...)\`:

\`\`\`php
if (class_exists(\\App\\Http\\Middleware\\StrapiEndpointCors::class)) {
    \\Illuminate\\Http\\Middleware\\HandleCors::skipWhen(\\App\\Http\\Middleware\\StrapiEndpointCors::answers(...));
}
\`\`\``;

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

const guardSection = (endpoints: Endpoint[]): string => {
  const guarded = endpoints.filter(isGuardedEndpoint).sort((a, b) => a.name.localeCompare(b.name));
  return guarded.length === 0 ? "" : endpointGuardsSection(guarded).slice(2) + "\n\n";
};

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
    endpoints = [],
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

${layout === "strapi" ? "" : adminSection}${cors ? corsSection.slice(2) + "\n\n" : ""}${sessions ? sessionsSection.slice(2) + "\n\n" : ""}${graphql ? graphqlSection.slice(2) + "\n\n" : ""}${documentation ? documentationSection.slice(2) + "\n\n" : ""}${transfer ? transferSection.slice(2) + "\n\n" : ""}${schedules ? schedulesSection.slice(2) + "\n\n" : ""}${mcp ? mcpSection.slice(2) + "\n\n" : ""}${guardSection(endpoints)}## Shared hosting (no shell)

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
