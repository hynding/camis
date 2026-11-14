import { isAbsolute, dirname, join, resolve } from "node:path";
import type { StorageLayout } from "@camis/adapter-kernel";
import type { Io } from "../io";

const STOCK_TRAIT_USE = "use HasFactory, Notifiable;";
const ROLES_ONLY_TRAIT_USE = "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles;";
const TOKENS_TRAIT_USE =
  "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles, \\Laravel\\Sanctum\\HasApiTokens;";
// Every patched form starts so, the one from before admin accounts were separate (which goes on
// with the AdminAccess trait) included.
const PATCHED_TRAITS = TOKENS_TRAIT_USE.slice(0, -1);

/**
 * Add Spatie's HasRoles and Sanctum's HasApiTokens to the Laravel User model: the API's users hold
 * the IR's roles and Sanctum tokens. Idempotent. The User is not a Filament user: the admin's
 * accounts are the generated AdminUser, apart from the API's users, as Strapi keeps them.
 *
 * Handles the stock form and the roles-only one the non-strapi boot path left (HasRoles but no
 * HasApiTokens, which would leave an app that cannot issue Sanctum tokens). A model patched before
 * admin accounts were separate (with AdminAccess and FilamentUser) is left as it is: the trait is
 * still generated, and lets no User into the admin. A source matching none is returned unchanged;
 * the caller treats that as a failure rather than reporting a patch that never happened.
 */
export const patchUserModel = (source: string): string => {
  if (source.includes(PATCHED_TRAITS)) return source;
  const from = [ROLES_ONLY_TRAIT_USE, STOCK_TRAIT_USE].find((form) => source.includes(form));
  return from === undefined ? source : source.replace(from, TOKENS_TRAIT_USE);
};

/** Whether the User model carries HasRoles and HasApiTokens. */
export const isPatchedUserModel = (source: string): boolean => source.includes(PATCHED_TRAITS);

const STOCK_PANEL_LOGIN = "            ->login()\n";
const ADMIN_GUARD = "->authGuard('admin')";

const ADMIN_LOCALE = "AdminLocale::class";
// Guarded: an app on Strapi's own storage layout has no admin accounts, so camis emits neither.
const PROFILE_AND_LOCALE =
  "            ->profile(class_exists(\\App\\Filament\\Pages\\AdminProfile::class) ? \\App\\Filament\\Pages\\AdminProfile::class : null, isSimple: false)\n" +
  "            ->middleware(class_exists(\\App\\Http\\Middleware\\AdminLocale::class) ? [\\App\\Http\\Middleware\\AdminLocale::class] : [], isPersistent: true)\n";

/**
 * Sign the admin panel in on the generated `admin` guard, whose accounts are AdminUser rows apart
 * from the API's users, and give it the admin's profile page and interface language (Strapi's
 * preferedLanguage). Idempotent, and completes a panel an earlier camis patched. A source without
 * the stock `->login()` line is returned unchanged; the caller treats that as a failure rather than
 * reporting a patch that never happened.
 */
export const patchAdminPanelProvider = (source: string): string => {
  const guarded = source.includes(ADMIN_GUARD)
    ? source
    : source.replace(STOCK_PANEL_LOGIN, `${STOCK_PANEL_LOGIN}            ${ADMIN_GUARD}\n`);
  const guardLine = `            ${ADMIN_GUARD}\n`;
  return guarded.includes(ADMIN_LOCALE) || !guarded.includes(guardLine)
    ? guarded
    : guarded.replace(guardLine, `${guardLine}${PROFILE_AND_LOCALE}`);
};

const STOCK_ROUTING_CONSOLE = "commands: __DIR__.'/../routes/console.php',";
const ROUTING_WITH_API = `api: __DIR__.'/../routes/api.php',\n        ${STOCK_ROUTING_CONSOLE}`;

/**
 * Register `routes/api.php` in Laravel 12's bootstrap/app.php. Idempotent.
 *
 * The stock skeleton routes only `web` and `console`; on the Laravel layout `php artisan
 * install:api` adds the API entry, but that command also installs Sanctum, which the Strapi
 * storage layout must not have. This is the same edit install:api makes, without the package.
 * A source matching neither form is returned unchanged; the caller treats that as a failure
 * rather than reporting a patch that never happened.
 */
export const patchBootstrapApp = (source: string): string => {
  if (source.includes("routes/api.php")) return source;
  return source.replace(STOCK_ROUTING_CONSOLE, ROUTING_WITH_API);
};

const STOCK_WITH_MIDDLEWARE = `->withMiddleware(function (Middleware $middleware): void {
        //
    })`;
const STRAPI_ERRORS_FIRST = `->withMiddleware(function (Middleware $middleware): void {
        // camis: the Strapi error envelope must wrap every API route, ahead of auth and throttling.
        if (class_exists(\\App\\Http\\Middleware\\StrapiErrors::class)) {
            $middleware->prependToGroup('api', \\App\\Http\\Middleware\\StrapiErrors::class);
            // Strapi stores a string as sent, spaces and empty ones included.
            $strapiRoutes = fn (\\Illuminate\\Http\\Request $request): bool => $request->is('api', 'api/*', 'graphql');
            $middleware->trimStrings(except: [$strapiRoutes]);
            $middleware->convertEmptyStringsToNull(except: [$strapiRoutes]);
        }
    })`;

/**
 * Prepend the generated StrapiErrors middleware to the `api` group in bootstrap/app.php.
 * Idempotent.
 *
 * routes/api.php does the same at load time, but `php artisan route:cache` (which every shared
 * host deploy should run) stops Laravel loading route files, so that call is lost and Authenticate
 * then runs before the envelope, 500ing on the missing `login` route. bootstrap/app.php runs on
 * every request. The class_exists guard keeps a laravel-API-style app, which has no StrapiErrors,
 * booting. A source not matching the stock skeleton is returned unchanged; the caller fails loudly.
 */
export const patchBootstrapMiddleware = (source: string): string => {
  if (source.includes("StrapiErrors::class")) return source;
  return source.replace(STOCK_WITH_MIDDLEWARE, STRAPI_ERRORS_FIRST);
};

const STOCK_WITH_EXCEPTIONS = `->withExceptions(function (Exceptions $exceptions): void {
        //
    })`;
const SENTRY_HANDLES = `->withExceptions(function (Exceptions $exceptions): void {
        // camis: report to Sentry, as Strapi's sentry plugin did, once sentry/sentry-laravel is installed.
        if (class_exists(\\Sentry\\Laravel\\Integration::class)) {
            \\Sentry\\Laravel\\Integration::handles($exceptions);
        }
    })`;

/**
 * Hand the app's exceptions to Sentry's Laravel SDK, which a project migrated from Strapi's sentry
 * plugin installs (deployment.env names it). Idempotent. The class_exists guard keeps an app
 * without the SDK booting. A source not matching the stock skeleton is returned unchanged; the
 * caller fails loudly.
 */
export const patchBootstrapExceptions = (source: string): string => {
  if (source.includes("Integration::handles(")) return source;
  return source.replace(STOCK_WITH_EXCEPTIONS, SENTRY_HANDLES);
};

const STOCK_HEALTH = "        health: '/up',\n";
const THEN_OPEN = "        then: function (): void {\n";
const loadRoutes = (file: string): string =>
  `            if (is_file(__DIR__.'/../routes/${file}')) {
                \\Illuminate\\Support\\Facades\\Route::middleware('api')->group(__DIR__.'/../routes/${file}');
            }
`;

/**
 * Load a generated route file from withRouting's `then`, in the api middleware group, opening the
 * callback beside the stock `health` entry if no earlier patch has. Registering it there keeps it
 * in `php artisan route:cache`; the is_file guard keeps a project generated without it booting. A
 * source with neither is returned unchanged; the caller fails loudly.
 */
const patchBootstrapRoutes = (source: string, file: string): string => {
  if (source.includes(`routes/${file}`)) return source;
  if (source.includes(THEN_OPEN)) return source.replace(THEN_OPEN, THEN_OPEN + loadRoutes(file));
  return source.replace(
    STOCK_HEALTH,
    `${STOCK_HEALTH}        // camis: Strapi's routes beside /api rather than under it.\n${THEN_OPEN}${loadRoutes(file)}        },\n`,
  );
};

/** Strapi serves GraphQL at /graphql, outside the /api prefix every routes/api.php route takes. */
export const patchBootstrapGraphql = (source: string): string =>
  patchBootstrapRoutes(source, "graphql.php");

/** Strapi's transfer runner is /admin/transfer/runner/*, outside /api too. */
export const patchBootstrapTransfer = (source: string): string =>
  patchBootstrapRoutes(source, "transfer.php");

const LOAD_SCHEDULE = `
// camis: the IR's schedules, generated into routes/schedule.php when it declares any.
if (is_file(__DIR__.'/schedule.php')) {
    require __DIR__.'/schedule.php';
}
`;

/**
 * Load the generated routes/schedule.php from routes/console.php, where Laravel 12 defines its
 * schedule. Idempotent. The is_file guard keeps a project generated without schedules booting.
 */
export const patchConsoleRoutes = (source: string): string =>
  source.includes("/schedule.php'") ? source : source + LOAD_SCHEDULE;

const patchConsole = async (appDir: string, io: Io): Promise<void> => {
  const consolePath = join(appDir, "routes/console.php");
  let source = "<?php\n";
  try {
    source = await io.readFile(consolePath);
  } catch {
    // An app without the stock file gets one that does only this.
  }
  await io.writeFile(consolePath, patchConsoleRoutes(source));
  io.out("✓ patched routes/console.php to load routes/schedule.php");
};

/**
 * One read and one write of bootstrap/app.php: the api routes entry on the Strapi storage layout
 * (which skips `install:api`), and StrapiErrors first on the api group on both layouts.
 */
const patchBootstrap = async (
  appDir: string,
  io: Io,
  storage: StorageLayout,
  graphql: boolean,
): Promise<boolean> => {
  const bootstrapPath = join(appDir, "bootstrap/app.php");
  try {
    const source = await io.readFile(bootstrapPath);
    let patched = source;
    if (storage === "strapi") {
      patched = patchBootstrapApp(patched);
      if (!patched.includes("routes/api.php")) {
        io.out(
          "✗ could not patch bootstrap/app.php: no recognised `commands: …/routes/console.php` routing line",
        );
        return false;
      }
    }
    patched = patchBootstrapMiddleware(patched);
    if (!patched.includes("StrapiErrors::class")) {
      io.out(
        "✗ could not patch bootstrap/app.php: `->withMiddleware(...)` is not the stock Laravel 12 form",
      );
      return false;
    }
    patched = patchBootstrapExceptions(patched);
    if (!patched.includes("Integration::handles(")) {
      io.out(
        "✗ could not patch bootstrap/app.php: `->withExceptions(...)` is not the stock Laravel 12 form",
      );
      return false;
    }
    patched = patchBootstrapTransfer(patched);
    if (!patched.includes("routes/transfer.php")) {
      io.out("✗ could not patch bootstrap/app.php: no stock `health: '/up',` routing line");
      return false;
    }
    if (graphql) {
      patched = patchBootstrapGraphql(patched);
      if (!patched.includes("routes/graphql.php")) {
        io.out("✗ could not patch bootstrap/app.php: no stock `health: '/up',` routing line");
        return false;
      }
    }
    await io.writeFile(bootstrapPath, patched);
    if (storage === "strapi") io.out("✓ patched bootstrap/app.php to route routes/api.php");
    if (graphql) io.out("✓ patched bootstrap/app.php to route routes/graphql.php");
    io.out("✓ patched bootstrap/app.php to route routes/transfer.php");
    io.out("✓ patched bootstrap/app.php to run StrapiErrors first on API routes");
    io.out("✓ patched bootstrap/app.php to report errors to Sentry once its SDK is installed");
    return true;
  } catch (e) {
    io.out(`✗ cannot patch ${bootstrapPath}: ${(e as Error).message}`);
    return false;
  }
};

// The exact sequence proven by the adapter-filament boot CI workflow.
const steps = (
  appDir: string,
  parentDir: string,
  createArg: string,
): { cmd: string; args: string[]; cwd: string }[] => [
  {
    cmd: "composer",
    args: ["create-project", "laravel/laravel:^12", createArg, "--no-interaction"],
    cwd: parentDir,
  },
  {
    cmd: "composer",
    args: ["require", "filament/filament:^5.0", "--no-interaction"],
    cwd: appDir,
  },
  {
    cmd: "php",
    args: ["artisan", "filament:install", "--panels", "--no-interaction"],
    cwd: appDir,
  },
  { cmd: "php", args: ["artisan", "install:api", "--no-interaction"], cwd: appDir },
  {
    cmd: "composer",
    args: ["require", "spatie/laravel-permission", "--no-interaction"],
    cwd: appDir,
  },
  {
    cmd: "php",
    args: [
      "artisan",
      "vendor:publish",
      "--provider=Spatie\\Permission\\PermissionServiceProvider",
      "--no-interaction",
    ],
    cwd: appDir,
  },
];

// The lean host for the Strapi storage layout: no Filament, no Spatie, no `install:api`, no
// User model patch — the app runs atop a database Strapi already owns and authenticates with
// its own JWT guard instead of Sanctum.
const strapiSteps = (
  appDir: string,
  parentDir: string,
  createArg: string,
): { cmd: string; args: string[]; cwd: string }[] => [
  {
    cmd: "composer",
    args: ["create-project", "laravel/laravel:^12", createArg, "--no-interaction"],
    cwd: parentDir,
  },
  {
    cmd: "composer",
    args: ["require", "firebase/php-jwt", "visus/cuid2", "--no-interaction"],
    cwd: appDir,
  },
];

export const scaffoldCommand = async (
  target: string,
  dir: string,
  io: Io,
  options?: { storage?: StorageLayout; graphql?: boolean },
): Promise<number> => {
  if (target !== "filament") {
    io.out(`✗ "${target}" has no scaffold; only the filament target needs a host app`);
    return 1;
  }
  const storage = options?.storage ?? "laravel";
  const appDir = isAbsolute(dir) ? dir : resolve(io.cwd, dir);
  try {
    await io.readFile(join(appDir, "composer.json"));
    io.out(`✗ ${dir} already contains a composer project; refusing to scaffold over it`);
    return 1;
  } catch {
    // no composer.json → safe to scaffold
  }

  const graphql = options?.graphql === true;
  const stepList = [
    ...(storage === "strapi"
      ? strapiSteps(appDir, dirname(appDir), appDir)
      : steps(appDir, dirname(appDir), appDir)),
    ...(graphql
      ? [
          {
            cmd: "composer",
            args: ["require", "webonyx/graphql-php:^15.19", "--no-interaction"],
            cwd: appDir,
          },
        ]
      : []),
  ];

  // composer create-project runs in the parent, which `camis new` has not created yet.
  await io.makeDir(dirname(appDir));
  for (const step of stepList) {
    io.out(`→ ${step.cmd} ${step.args.join(" ")}`);
    const code = await io.exec(step.cmd, step.args, step.cwd);
    if (code !== 0) {
      io.out(`✗ ${step.cmd} ${step.args.join(" ")} exited ${code}`);
      return 1;
    }
  }

  if (!(await patchBootstrap(appDir, io, storage, graphql))) return 1;
  await patchConsole(appDir, io);

  if (storage === "strapi") {
    io.out(`✓ scaffolded Laravel 12 (Strapi storage) at ${dir}`);
    io.out(`  next: point a filament target's "out" at ${dir} and run: camis build`);
    return 0;
  }

  const userModelPath = join(appDir, "app/Models/User.php");
  try {
    const source = await io.readFile(userModelPath);
    const patched = patchUserModel(source);
    if (!isPatchedUserModel(patched)) {
      io.out(
        "✗ could not patch app/Models/User.php: no recognised `use HasFactory, Notifiable…` trait line or `class User extends Authenticatable`",
      );
      return 1;
    }
    await io.writeFile(userModelPath, patched);
    io.out("✓ patched app/Models/User.php with Spatie HasRoles and Sanctum HasApiTokens");
  } catch (e) {
    io.out(`✗ cannot patch ${userModelPath}: ${(e as Error).message}`);
    return 1;
  }

  const panelPath = join(appDir, "app/Providers/Filament/AdminPanelProvider.php");
  try {
    const patched = patchAdminPanelProvider(await io.readFile(panelPath));
    if (!patched.includes(ADMIN_GUARD)) {
      io.out("✗ could not patch the admin panel provider: no stock `->login()` line");
      return 1;
    }
    await io.writeFile(panelPath, patched);
    io.out("✓ patched the admin panel to sign in on the admin guard (admin accounts)");
  } catch (e) {
    io.out(`✗ cannot patch ${panelPath}: ${(e as Error).message}`);
    return 1;
  }

  io.out(`✓ scaffolded Laravel 12 + Filament v5 + Spatie at ${dir}`);
  io.out(`  next: point a filament target's "out" at ${dir} and run: camis build`);
  return 0;
};
