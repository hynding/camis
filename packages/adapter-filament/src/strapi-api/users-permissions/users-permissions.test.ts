import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../../hooks/names";
import { filamentAdapter } from "../../generate";
import { strapiApiBundle } from "../__fixtures__/strapi-api";
import {
  emitStrapiActiveUser,
  emitStrapiSettings,
  emitStrapiUsers,
  emitUserController,
} from "./users-permissions";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const result = filamentAdapter.generate(strapiApiBundle, {
  projectName: "oyl",
  apiStyle: "strapi",
});
const content = (p: string): string => {
  const f = result.files.find((x) => x.path === p || x.path.endsWith(p));
  if (!f) throw new Error(`not generated: ${p}`);
  return f.content;
};

const generated = [
  "app/Support/StrapiUsers.php",
  "app/Support/StrapiSettings.php",
  "app/Http/Controllers/Api/UserController.php",
  "app/Http/Middleware/StrapiActiveUser.php",
  "app/Filament/Resources/Users/UserResource.php",
  "app/Filament/Resources/Users/Pages/CreateUser.php",
  "app/Filament/Resources/Users/Pages/EditUser.php",
  "app/Filament/Resources/Users/Pages/ListUsers.php",
  "app/Filament/Pages/UsersPermissionsProviders.php",
  "app/Filament/Pages/UsersPermissionsEmailTemplates.php",
  "app/Filament/Pages/UsersPermissionsAdvancedSettings.php",
  "_add_users_permissions_to_users_table.php",
  "_create_strapi_settings_table.php",
];

describe("users-permissions runtime", () => {
  it.each(generated)("%s is generated", (path) => {
    expect(content(path).startsWith("<?php\n")).toBe(true);
  });
  it.each(generated.filter((path) => !path.startsWith("app/Filament/")))("%s is marked", (path) => {
    expect(content(path)).toContain(PHP_MARKER);
  });
  it("StrapiUsers golden", async () => {
    await expect(emitStrapiUsers()).toMatchFileSnapshot("../__golden__/strapi-api/StrapiUsers.php");
  });
  it("StrapiSettings golden", async () => {
    await expect(emitStrapiSettings()).toMatchFileSnapshot(
      "../__golden__/strapi-api/StrapiSettings.php",
    );
  });
  it("StrapiActiveUser golden", async () => {
    await expect(emitStrapiActiveUser()).toMatchFileSnapshot(
      "../__golden__/strapi-api/StrapiActiveUser.php",
    );
  });
  it("UserController golden", async () => {
    await expect(emitUserController(true)).toMatchFileSnapshot(
      "../__golden__/strapi-api/UserController.php",
    );
  });
  it("users carry Strapi's wire shape, timestamps included", () => {
    const php = emitStrapiUsers();
    for (const key of ["documentId", "provider", "confirmed", "blocked", "publishedAt"])
      expect(php).toContain(`'${key}' =>`);
  });
});

describe("users-permissions grants", () => {
  // The fixture grants only read: the writes must be refused, not merely left out of the admin.
  it("gates every user route on its own permission", () => {
    const php = content("app/Http/Controllers/Api/UserController.php");
    for (const permission of ["user.read", "user.create", "user.update", "user.delete"])
      expect(php).toContain(`'${permission}'`);
  });
  // users-permissions' PUT /users/:id moves the user to the role its body names; one it cannot
  // find fails the update as the relation check does, before anything is saved.
  it("moves a user to the role an update names, refusing one that does not exist", () => {
    const php = emitUserController(true);
    expect(php).toContain(
      "$role = array_key_exists('role', $body) ? (is_scalar($body['role']) ? Role::query()->find($body['role']) : null) : false;",
    );
    expect(php).toMatch(
      /if \(\$role === null\) \{\n {12}throw StrapiUsers::application\('1 relation\(s\) of type plugin::users-permissions\.role associated with this entity do not exist'\);/,
    );
    expect(php).toContain("$user->syncRoles([$role]);");
    expect(emitUserController(false)).not.toContain("syncRoles");
  });
  it("seeds the read grant on the builtin user", () => {
    expect(content("database/seeders/RolePermissionSeeder.php")).toContain("'user.read'");
  });
  it("an unsecured project answers the user routes without permission checks", () => {
    expect(emitUserController(false)).not.toContain("->can(");
  });
});

describe("users-permissions routes", () => {
  const routes = content("routes/api.php");
  it.each([
    "Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])",
    "Route::post('/auth/reset-password', [AuthController::class, 'resetPassword'])",
    "Route::get('/auth/email-confirmation', [AuthController::class, 'emailConfirmation'])",
    "Route::post('/auth/send-email-confirmation', [AuthController::class, 'sendEmailConfirmation'])",
    "Route::post('/auth/change-password', [AuthController::class, 'changePassword'])",
    "Route::get('/users/count', [UserController::class, 'count'])",
    "Route::delete('/users/{id}', [UserController::class, 'destroy'])",
  ])("routes %s", (route) => {
    expect(routes).toContain(route);
  });
  it("routes /users/count and /users/me before /users/{id}", () => {
    expect(routes.indexOf("'/users/count'")).toBeLessThan(routes.indexOf("'/users/{id}'"));
    expect(routes.indexOf("'/users/me'")).toBeLessThan(routes.indexOf("'/users/{id}'"));
  });
  it("checks a blocked or unconfirmed session on every authenticated route", () => {
    expect(routes).toMatch(
      /Route::middleware\(\[StrapiCredentials::class\.':required', StrapiActiveUser::class\]\)/,
    );
  });
  // Strapi rate-limits it too: a stolen access token must not buy unlimited guesses of the password.
  it("throttles a password change, which checks the current password", () => {
    expect(routes).toContain(
      "Route::post('/auth/change-password', [AuthController::class, 'changePassword'])->middleware([StrapiJsonBody::class, StrapiThrottle::class.':password-change']);",
    );
  });
  // One bucket per group, so a flood of one (refreshes, recovery mails) never locks out sign-in.
  it("gives each group of credential routes a bucket of its own", () => {
    for (const [route, group] of [
      ["Route::post('/auth/local/register', [AuthController::class, 'register'])", "register"],
      [
        "Route::post('/auth/reset-password', [AuthController::class, 'resetPassword'])",
        "password-reset",
      ],
    ])
      expect(routes).toContain(
        `${route}->middleware([StrapiJsonBody::class, StrapiThrottle::class.':${group}', StrapiCredentials::class.':guest']);`,
      );
    expect(routes).not.toContain("$authThrottle");
  });
  // Keyed by the caller's account once it is known, by its address otherwise, through one limiter
  // the GraphQL mutations share, so REST and GraphQL count the same turns.
  // Only a password change: keyed by account, a sign-in, registration or recovery mail would get
  // a fresh bucket for every account whose token the caller sends (GraphQL reads one, as Strapi's).
  it("keys a password change by the signed-in account, every other group by address", () => {
    const limits = content("app/Support/StrapiRateLimits.php");
    expect(limits).toContain("private const PER_ACCOUNT = ['password-change'];");
    expect(limits).toContain("'user:'.$user->getAuthIdentifier()");
    expect(limits).toContain("'ip:'.$request->ip()");
    expect(content("app/Http/Middleware/StrapiThrottle.php")).toContain(
      "StrapiRateLimits::attempt($request, $group)",
    );
  });
  // A bucket per address alone is one a foreign client fills for every user behind that address;
  // per address and name, each name's guesses are counted apart, under a per-address ceiling. No
  // raw body text is a key: a fixed-length digest of the folded name. Nothing the lookup found
  // has a bucket, which would tell a caller which names are one account, or that one exists.
  it("keys sign-in, recovery and confirmation by address and the name, under a ceiling", () => {
    const limits = content("app/Support/StrapiRateLimits.php");
    expect(limits).toContain("private const NAMED = ['sign-in', 'recovery', 'confirmation'];");
    expect(limits).toContain("substr(hash('sha256', self::folded($identifier)), 0, 32)");
    expect(limits).not.toContain("account:");
    expect(limits).toContain(
      "public static function refuseNamed(Request $request, string $group, string $identifier): void",
    );
    expect(limits).toContain("'camis.users_permissions.auth_address_throttle_per_minute'");
    expect(content("config/camis.php")).toContain(
      "'auth_address_throttle_per_minute' => max(1, (int) env('CAMIS_AUTH_ADDRESS_THROTTLE_PER_MINUTE', 50)),",
    );
  });
  // Case, width and accents that a database collation may ignore buy no fresh bucket.
  it("folds case, width and accents out of a name before it is hashed", () => {
    const limits = content("app/Support/StrapiRateLimits.php");
    expect(limits).toContain("\\Normalizer::normalize(trim($identifier), \\Normalizer::FORM_KD)");
    expect(limits).toContain("MB_CASE_FOLD");
  });
  // The throttle and the account lookup must never read the name from different places (a query
  // string against a body of another content type): the controller hands over the very value it
  // looks the account up by, and nothing in the limiter reads the request's fields.
  it("takes the named groups' turns in the controller, with the name the lookup used", () => {
    const limits = content("app/Support/StrapiRateLimits.php");
    expect(limits).not.toContain("$request->input(");
    expect(limits).not.toContain("$request->json(");
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    const login = auth.slice(
      auth.indexOf("public function login"),
      auth.indexOf("public function changePassword"),
    );
    expect(login).toContain("StrapiRateLimits::refuseNamed($request, 'sign-in', $identifier);");
    // Taken before the lookup, so what it finds cannot bear on the turn.
    expect(login.indexOf("refuseNamed")).toBeLessThan(login.indexOf("User::query()"));
    for (const [method, group] of [
      ["forgotPassword", "recovery"],
      ["sendEmailConfirmation", "confirmation"],
    ]) {
      const body = auth.slice(auth.indexOf(`public function ${method}`));
      expect(body).toContain(`StrapiRateLimits::refuseNamed($request, '${group}', $email);`);
      expect(body.indexOf("refuseNamed")).toBeLessThan(body.indexOf("User::query()"));
    }
    for (const route of [
      "Route::post('/auth/local', [AuthController::class, 'login'])",
      "Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])",
      "Route::post('/auth/send-email-confirmation', [AuthController::class, 'sendEmailConfirmation'])",
    ])
      expect(routes).toContain(
        `${route}->middleware([StrapiJsonBody::class, StrapiCredentials::class.':guest']);`,
      );
  });
  // A body of text/plain or a form is a request a page of another site sends with no CORS
  // preflight, so a route that reads its body as JSON whatever its type would take a foreign
  // page's sign-in, registration or recovery mail. Strapi's own clients all send JSON.
  it("takes an auth write's body only as JSON, refusing any other type with 415", () => {
    for (const route of [
      "Route::post('/auth/local', [AuthController::class, 'login'])",
      "Route::post('/auth/local/register', [AuthController::class, 'register'])",
      "Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])",
      "Route::post('/auth/reset-password', [AuthController::class, 'resetPassword'])",
      "Route::post('/auth/send-email-confirmation', [AuthController::class, 'sendEmailConfirmation'])",
      "Route::post('/auth/refresh', [SessionController::class, 'refresh'])",
      "Route::post('/auth/change-password', [AuthController::class, 'changePassword'])",
      "Route::post('/auth/logout', [SessionController::class, 'logout'])",
    ])
      expect(routes).toContain(`${route}->middleware([StrapiJsonBody::class`);
    expect(routes).toContain("use App\\Http\\Middleware\\StrapiJsonBody;");
    const middleware = content("app/Http/Middleware/StrapiJsonBody.php");
    expect(middleware).toContain("new StrapiError(415, 'UnsupportedMediaTypeError'");
    expect(middleware).toContain("$request->getContent() === ''");
    // PHP parses a form into fields and files, leaving the raw body empty.
    expect(middleware).toContain(
      "$request->request->count() === 0 && $request->files->count() === 0",
    );
    expect(middleware).toContain("$type === 'application/json'");
    expect(middleware).toContain("str_ends_with($type, '+json')");
  });
  // Strapi validates strictly: yup's string() refuses a number, boolean, null, array or object.
  it("refuses a name that is not a string as Strapi's strict validation does", () => {
    const users = content("app/Support/StrapiUsers.php");
    expect(users).toContain(
      "$check === 'string' => array_key_exists($field, $body) && ! is_string($value),",
    );
    expect(users).not.toContain("casts a number");
    expect(users).toContain(
      "\"{$field} must be a `string` type, but the final value was: `\".self::yupPrinted($value).'`.'",
    );
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    expect(auth).toContain(
      "['identifier' => ['string', 'required'], 'password' => ['string', 'required']]",
    );
    expect(auth.match(/\['email' => \['string', 'required', 'email'\]\]/g)).toHaveLength(2);
  });
  // Every value an auth route casts to a string is first checked to be one, so an array or object
  // answers Strapi's ValidationError rather than a server error.
  it("checks every auth and user field it casts to be a string first", () => {
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    for (const rules of [
      "['password' => ['string', 'required', 'maxPassword'], 'passwordConfirmation' => ['string', 'required', 'same:password'], 'currentPassword' => ['string', 'required']]",
      "['password' => ['string', 'required', 'maxPassword'], 'passwordConfirmation' => ['string', 'required', 'same:password'], 'code' => ['string', 'required']]",
      "StrapiUsers::validate($query, ['confirmation' => ['string', 'required']]);",
    ])
      expect(auth).toContain(rules);
    const users = content("app/Http/Controllers/Api/UserController.php");
    expect(users).toContain(
      "['email' => ['string', 'required', 'email', 'max:255'], 'username' => ['string', 'required', 'max:255'], 'password' => ['string', 'required'], 'role' => ['required', 'id']]",
    );
    // Strapi's update takes a missing, null or empty password (then refused as password.notNull)
    // and refuses any other value that is not a string.
    expect(users).toContain(
      "['email' => ['string', 'email', 'nonEmpty', 'max:255'], 'username' => ['string', 'nonEmpty', 'max:255'], 'password' => ['updatePassword'], 'role' => ['id']]",
    );
  });
  // Login refuses a name longer than the name columns: no account may be made with one.
  it("refuses a username or email longer than login takes on registration", () => {
    expect(content("app/Http/Controllers/Api/AuthController.php")).toContain(
      "['email' => ['string', 'required', 'email', 'max:255'], 'username' => ['string', 'required', 'max:255'], 'password' => ['string', 'required', 'maxPassword']]",
    );
    expect(content("app/Support/StrapiUsers.php")).toContain(
      "str_starts_with($check, 'max:') => \"{$field} must be at most \".substr($check, 4).' characters',",
    );
  });
  // No account's username or email is longer than its column; a longer name is refused as a wrong
  // one before it is folded or looked up.
  it("refuses an identifier longer than any account's name before folding or looking it up", () => {
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    const login = auth.slice(auth.indexOf("public function login"));
    expect(login).toContain("mb_strlen($identifier) > self::MAX_IDENTIFIER_LENGTH");
    expect(login.indexOf("MAX_IDENTIFIER_LENGTH")).toBeLessThan(login.indexOf("refuseNamed"));
  });
  // Strapi's answers tell a caller whether an account exists; camis hides it unless told not to.
  it("hides whether an account exists, unless the deployment turns it off", () => {
    expect(content("config/camis.php")).toContain(
      "'hide_account_existence' => (bool) env('CAMIS_AUTH_HIDE_ACCOUNT_EXISTENCE', true),",
    );
    const users = content("app/Support/StrapiUsers.php");
    expect(users).toContain("app()->terminating(");
    expect(users).toContain(
      "public static function passwordMatches(?User $user, string $password): bool",
    );
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    expect(auth).toContain("StrapiUsers::passwordMatches($user, (string) $body['password'])");
    expect(auth).toContain("StrapiUsers::later(");
  });
  // Checking and then counting lets parallel requests all pass the check: the count hit() returns
  // is the decision.
  it("decides on the count it takes, so parallel requests cannot pass one check together", () => {
    const limits = content("app/Support/StrapiRateLimits.php");
    expect(limits).toContain("RateLimiter::hit($key, 60) > $max");
    expect(limits).not.toContain("tooManyAttempts(");
  });
});

// user-query-vectors.json, recorded from strapi-php, is the behaviour: register's allowedFields,
// and the /users routes' start/limit pagination and populate (the role for an API token alone).
describe("users-permissions register and /users queries", () => {
  it("lets a project allow more register keys, as users-permissions' register.allowedFields", () => {
    expect(content("config/camis.php")).toContain(
      "'allowed_fields' => array_values(array_filter(array_map('trim', explode(',', (string) env('CAMIS_REGISTER_ALLOWED_FIELDS', ''))))),",
    );
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    expect(auth).toContain("config('camis.users_permissions.register.allowed_fields', [])");
    expect(auth).not.toContain("private const REGISTER_KEYS");
  });
  it("lists users with start and limit, and populates them", () => {
    const php = content("app/Http/Controllers/Api/UserController.php");
    expect(php).toContain("StrapiUsers::paginate($query, $params)");
    expect(php).toContain("StrapiPopulate::many(");
    expect(php).toContain("StrapiPopulate::one(");
  });
  it("renders a populated role through a role serializer an API token may read", () => {
    expect(content("app/Http/Serializers/UserSerializer.php")).toContain(
      "'serializer' => \\App\\Http\\Serializers\\RoleSerializer::class",
    );
    expect(content("app/Http/Serializers/RoleSerializer.php")).toContain(
      "public static function toWire(Role $m): array",
    );
    expect(content("app/Support/StrapiApiTokens.php")).toContain(
      "\\Spatie\\Permission\\Models\\Role::class => 'plugin::users-permissions.role'",
    );
    // A populated role is Spatie's configured model, which a token reads with the role's find.
    expect(content("app/Support/StrapiApiTokens.php")).toContain(
      "\\App\\Models\\StrapiRole::class => 'plugin::users-permissions.role'",
    );
  });
  it("keeps a role's own documentId, on a column added after Spatie made the roles table", () => {
    expect(content("app/Http/Serializers/RoleSerializer.php")).toContain(
      "'documentId' => ['column' => 'document_id', 'type' => 'string']",
    );
    const migration = result.files.find((f) =>
      f.path.endsWith("_add_document_id_to_roles_table.php"),
    );
    expect(migration?.content).toContain(
      "$table->string('document_id', 24)->nullable()->unique();",
    );
    // Spatie's migration is named for the day it was published, so this one must sort after any date.
    expect(
      migration !== undefined &&
        migration.path > "database/migrations/2999_12_31_235959_create_permission_tables.php",
    ).toBe(true);
  });
  // Strapi keeps every timestamp to the millisecond, its users' and roles' too.
  it("keeps users' and roles' timestamps to the millisecond, on columns widened after Spatie's", () => {
    const migration = result.files.find((f) =>
      f.path.endsWith("_millisecond_timestamps_on_users_and_roles.php"),
    );
    expect(
      migration !== undefined &&
        migration.path > "database/migrations/9999_12_31_000000_add_document_id_to_roles_table.php",
    ).toBe(true);
    expect(migration?.content).toContain("$this->precision(3);");
    expect(migration?.content).toContain(
      "$table->timestamp('created_at', $precision)->nullable()->change();",
    );
    expect(migration?.content).toContain("config('permission.table_names.roles', 'roles')");
    // SQLite keeps a datetime as the text written: nothing to widen there.
    expect(migration?.content).toContain("=== 'sqlite'");

    const role = content("app/Models/StrapiRole.php");
    expect(role).toContain("class StrapiRole extends SpatieRole");
    expect(role).toContain("use HasMillisecondTimestamps;");
    // Spatie hands out its configured role model, so every role read or written is this one.
    const config = content("config/permission.php");
    expect(config).toContain("'role' => App\\Models\\StrapiRole::class,");
    expect(config).toContain("'permission' => Spatie\\Permission\\Models\\Permission::class,");
  });
  it("brings a role's archived timestamps over to the millisecond", () => {
    expect(content("app/Support/StrapiImport.php")).toContain(
      "self::value($entity['data']['createdAt'] ?? null, 'dateTime', $role->getDateFormat())",
    );
  });
  it("user-query-vectors: every step has a unique name and a recorded strapi-php outcome", () => {
    const read = (file: string): unknown =>
      JSON.parse(readFileSync(join(__dirname, "..", "__fixtures__", file), "utf8"));
    const { steps } = read("user-query-vectors.json") as { steps: { name?: string }[] };
    const names = steps.flatMap((s) => (s.name === undefined ? [] : [s.name]));
    expect(new Set(names).size).toBe(names.length);
    const recorded = read("user-query-vectors.expected.json") as { name: string }[];
    expect(recorded.map((o) => o.name)).toEqual(names);
  });
});

describe("users-permissions config and errors", () => {
  it("stores a matched password again when its hash is not the configured one", () => {
    expect(content("app/Support/StrapiUsers.php")).toContain("Hash::needsRehash(");
  });
  // A concurrent registration can take the name between the check and the insert.
  it("answers a registration whose insert finds its name taken as a taken one", () => {
    expect(content("app/Http/Controllers/Api/AuthController.php")).toContain(
      "} catch (UniqueConstraintViolationException) {",
    );
  });
  // A mail goes to an address the caller names, so a caller could otherwise mail anyone at will.
  it("bounds each kind of account mail per recipient, by a setting", () => {
    expect(content("config/camis.php")).toContain(
      "'account_mail_per_hour' => max(1, (int) env('CAMIS_ACCOUNT_MAIL_PER_HOUR', 1)),",
    );
    expect(content("app/Support/StrapiRateLimits.php")).toContain(
      "public static function mailable(string $kind, string $address): bool",
    );
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    for (const kind of ["registration-notice", "confirmation", "reset-password"])
      expect(auth).toContain(`StrapiRateLimits::mailable('${kind}', `);
  });
  // Which of the address or the username was taken is what a registrant must not learn.
  it("has one registration notice, naming neither the address nor the username as taken", () => {
    const config = content("config/camis.php");
    expect(config).toContain("'registration_attempted' => [");
    expect(config).not.toContain("'username_taken'");
    expect(content("app/Support/StrapiUsers.php")).toContain(
      "public static function sendRegistrationNotice(string $email): void",
    );
  });
  // Strapi's bcryptjs writes $2a$, which Laravel's bcrypt refuses to verify and throws on: an
  // imported account must sign in, and a hash no hasher verifies must fail as a wrong password.
  it("reads bcryptjs hashes as PHP's and fails a hash the hasher cannot verify as a wrong one", () => {
    const hashes = content("app/Support/StrapiHashes.php");
    expect(hashes).toContain("public static function fromBcryptjs(mixed $hash): ?string");
    expect(hashes).toContain(
      "public static function check(string $password, string $hash, string $account, int|string|null $id): bool",
    );
    // Which account, once an hour, and never its hash, password or names.
    expect(hashes).toContain("Cache::add('camis-unverifiable-hash:'.$account.':'.$id, true, 3600)");
    expect(content("app/Support/StrapiImport.php")).toContain(
      "'password' => StrapiHashes::fromBcryptjs($data['password'] ?? null),",
    );
    expect(content("app/Support/StrapiAdminImport.php")).toContain("StrapiHashes::fromBcryptjs(");
    expect(content("app/Support/StrapiUsers.php")).toContain("StrapiHashes::check(");
    expect(content("app/Http/Controllers/Api/AuthController.php")).toContain(
      "StrapiUsers::passwordMatches($user, (string) $body['currentPassword'])",
    );
  });
  it("keeps Strapi's advanced settings defaults in config", () => {
    const config = content("config/camis.php");
    for (const key of [
      "'allow_register'",
      "'email_confirmation'",
      "'unique_email'",
      "'email_reset_password'",
      "'email_confirmation_redirection'",
    ])
      expect(config).toContain(key);
  });
  // Strapi answers a request without credentials with the public role's verdict, and camis grants
  // the public role nothing, so it is a 403 there; a token that does not verify stays a 401.
  it("answers a request without a token with 403 Forbidden", () => {
    const php = content("app/Http/Middleware/StrapiErrors.php");
    expect(php).toContain("$request->bearerToken() === null");
    expect(php).toContain("$this->error(403, 'ForbiddenError', 'Forbidden')");
  });
});

describe.runIf(hasPhp())("users-permissions PHP", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "camis-users-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it.each([...generated, "app/Http/Controllers/Api/AuthController.php"])(
    "%s passes php -l",
    (path) => {
      const file = join(dir, path.replaceAll("/", "_"));
      writeFileSync(file, content(path));
      expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain("No syntax errors");
    },
  );
});
