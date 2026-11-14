import { describe, expect, it } from "vitest";
import type { Io } from "../io";
import {
  patchBootstrapApp,
  patchBootstrapGraphql,
  patchBootstrapExceptions,
  patchBootstrapMiddleware,
  patchBootstrapTransfer,
  patchConsoleRoutes,
  isPatchedUserModel,
  patchAdminPanelProvider,
  patchUserModel,
  scaffoldCommand,
} from "./scaffold";

interface ExecCall {
  cmd: string;
  args: string[];
  cwd: string;
}

const fakeIo = (opts: {
  files?: Record<string, string>;
  execResults?: number[];
}): {
  io: Io;
  calls: ExecCall[];
  lines: string[];
  written: Record<string, string>;
  madeDirs: string[];
} => {
  const calls: ExecCall[] = [];
  const madeDirs: string[] = [];
  const lines: string[] = [];
  const written: Record<string, string> = {};
  const files = opts.files ?? {};
  const execResults = opts.execResults ?? [];
  const io: Io = {
    readFile: (p) =>
      p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`)),
    writeFile: (p, c) => {
      written[p] = c;
      return Promise.resolve();
    },
    materialize: () => Promise.resolve(),
    copyDir: () => Promise.resolve(),
    makeDir: (p) => {
      madeDirs.push(p);
      return Promise.resolve();
    },
    exec: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return Promise.resolve(execResults[calls.length - 1] ?? 0);
    },
    out: (l) => lines.push(l),
    cwd: "/proj",
  };
  return { io, calls, lines, written, madeDirs };
};

const STOCK_USER = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Factories\\HasFactory;
use Illuminate\\Foundation\\Auth\\User as Authenticatable;
use Illuminate\\Notifications\\Notifiable;

class User extends Authenticatable
{
    use HasFactory, Notifiable;
}
`;

const FULL_TRAIT_USE =
  "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles, \\Laravel\\Sanctum\\HasApiTokens;";
// The shape an app scaffolded between admin roles and separate admin accounts has.
const ADMIN_TRAIT_USE = FULL_TRAIT_USE.replace(";", ", \\App\\Models\\Concerns\\AdminAccess;");
// The shape left by the non-strapi boot workflow, which adds HasRoles but not HasApiTokens.
const ROLES_ONLY_USER = STOCK_USER.replace(
  "use HasFactory, Notifiable;",
  "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles;",
);

describe("patchUserModel", () => {
  it("adds the HasRoles and HasApiTokens traits to the stock User model", () => {
    const patched = patchUserModel(STOCK_USER);
    expect(patched).toContain(FULL_TRAIT_USE);
    expect(isPatchedUserModel(patched)).toBe(true);
  });

  // Without this arm the HasApiTokens-less roles-only form fell through unchanged, so Sanctum
  // token creation blew up at runtime instead of at scaffold time.
  it("upgrades a User model that already has HasRoles but not HasApiTokens", () => {
    const patched = patchUserModel(ROLES_ONLY_USER);
    expect(patched).toContain(FULL_TRAIT_USE);
    expect(patched).not.toBe(ROLES_ONLY_USER);
  });

  it("is idempotent", () => {
    const once = patchUserModel(STOCK_USER);
    expect(patchUserModel(once)).toBe(once);
  });

  // Admin accounts are AdminUser rows, as Strapi keeps admin_users apart from up_users: an API
  // user is never a Filament user.
  it("leaves the User out of the admin", () => {
    for (const source of [STOCK_USER, ROLES_ONLY_USER]) {
      const patched = patchUserModel(source);
      expect(patched).not.toContain("FilamentUser");
      expect(patched).not.toContain("AdminAccess");
    }
  });

  // The generated AdminAccess still exists, and lets no User in, so an older app keeps booting.
  it("leaves a User model patched with the admin access before as it is", () => {
    const before = STOCK_USER.replace("use HasFactory, Notifiable;", ADMIN_TRAIT_USE).replace(
      "class User extends Authenticatable\n",
      "class User extends Authenticatable implements \\Filament\\Models\\Contracts\\FilamentUser\n",
    );
    expect(patchUserModel(before)).toBe(before);
    expect(isPatchedUserModel(before)).toBe(true);
  });
});

// The panel `php artisan filament:install --panels` writes, cut to what the patch reads.
const STOCK_PANEL = `<?php

namespace App\\Providers\\Filament;

class AdminPanelProvider extends PanelProvider
{
    public function panel(Panel $panel): Panel
    {
        return $panel
            ->default()
            ->id('admin')
            ->path('admin')
            ->login()
            ->colors([
                'primary' => Color::Amber,
            ]);
    }
}
`;

describe("patchAdminPanelProvider", () => {
  // Admin accounts are AdminUser rows on the generated admin guard, apart from the API's users.
  it("signs the admin panel in on the admin guard", () => {
    expect(patchAdminPanelProvider(STOCK_PANEL)).toContain(
      "            ->login()\n            ->authGuard('admin')\n            ->profile(",
    );
  });

  it("is idempotent", () => {
    const once = patchAdminPanelProvider(STOCK_PANEL);
    expect(patchAdminPanelProvider(once)).toBe(once);
  });

  // Strapi's profile page sets an admin's interface language, which the whole admin then speaks.
  it("gives the panel the admin's profile page and interface language", () => {
    const patched = patchAdminPanelProvider(STOCK_PANEL);
    expect(patched).toContain(
      "->profile(\\App\\Filament\\Pages\\AdminProfile::class, isSimple: false)",
    );
    expect(patched).toContain(
      "->middleware([\\App\\Http\\Middleware\\AdminLocale::class], isPersistent: true)",
    );
  });

  it("adds them to a panel an earlier camis already put on the admin guard", () => {
    const earlier = STOCK_PANEL.replace(
      "            ->login()\n",
      "            ->login()\n            ->authGuard('admin')\n",
    );
    expect(patchAdminPanelProvider(earlier)).toBe(patchAdminPanelProvider(STOCK_PANEL));
  });
});

const STOCK_BOOTSTRAP = `<?php

use Illuminate\\Foundation\\Application;
use Illuminate\\Foundation\\Configuration\\Exceptions;
use Illuminate\\Foundation\\Configuration\\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        //
    })->create();
`;

// Laravel 12's stock bootstrap/app.php registers no API routes; on the laravel layout
// `php artisan install:api` adds them, but the strapi layout skips that step (it would install
// Sanctum), so without this patch every generated /api route 404s.
describe("patchBootstrapApp", () => {
  it("registers routes/api.php on the stock Laravel 12 bootstrap", () => {
    expect(patchBootstrapApp(STOCK_BOOTSTRAP)).toContain("api: __DIR__.'/../routes/api.php',");
  });

  it("keeps the console and web entries", () => {
    const patched = patchBootstrapApp(STOCK_BOOTSTRAP);
    expect(patched).toContain("web: __DIR__.'/../routes/web.php',");
    expect(patched).toContain("commands: __DIR__.'/../routes/console.php',");
  });

  it("is idempotent", () => {
    const once = patchBootstrapApp(STOCK_BOOTSTRAP);
    expect(patchBootstrapApp(once)).toBe(once);
  });

  it("leaves an unrecognised bootstrap unchanged so the caller can fail loudly", () => {
    const hand = STOCK_BOOTSTRAP.replace("commands: __DIR__.'/../routes/console.php',", "");
    expect(patchBootstrapApp(hand)).toBe(hand);
  });
});

// Strapi's sentry plugin reports what a request throws; Laravel's SDK does so once its
// integration handles the app's exceptions. Guarded, so an app without the SDK still boots.
describe("patchBootstrapExceptions", () => {
  it("hands the app's exceptions to Sentry when its SDK is installed", () => {
    const patched = patchBootstrapExceptions(STOCK_BOOTSTRAP);
    expect(patched).toContain(`    ->withExceptions(function (Exceptions $exceptions): void {
        // camis: report to Sentry, as Strapi's sentry plugin did, once sentry/sentry-laravel is installed.
        if (class_exists(\\Sentry\\Laravel\\Integration::class)) {
            \\Sentry\\Laravel\\Integration::handles($exceptions);
        }
    })`);
  });

  it("is idempotent", () => {
    const once = patchBootstrapExceptions(STOCK_BOOTSTRAP);
    expect(patchBootstrapExceptions(once)).toBe(once);
  });

  it("leaves an unrecognised bootstrap unchanged so the caller can fail loudly", () => {
    const hand = STOCK_BOOTSTRAP.replace("        //\n    })->create();", "    })->create();");
    expect(patchBootstrapExceptions(hand)).toBe(hand);
  });
});

// routes/api.php prepends StrapiErrors to the `api` group, but `php artisan route:cache` skips route
// files on every later request, so a cached app lost the error envelope and 500'd unauthenticated
// requests. bootstrap/app.php runs on every request, cached or not.
describe("patchBootstrapMiddleware", () => {
  const LINE = "$middleware->prependToGroup('api', \\App\\Http\\Middleware\\StrapiErrors::class);";
  it("prepends StrapiErrors to the api group when the generated middleware exists", () => {
    const patched = patchBootstrapMiddleware(STOCK_BOOTSTRAP);
    expect(patched).toContain("if (class_exists(\\App\\Http\\Middleware\\StrapiErrors::class)) {");
    expect(patched).toContain(LINE);
    expect(patched).not.toContain("        //\n    })\n    ->withExceptions");
  });
  // Strapi stores a string as sent: Laravel's global middleware would trim it and turn "" into null.
  it("keeps Strapi's routes' strings as sent", () => {
    const patched = patchBootstrapMiddleware(STOCK_BOOTSTRAP);
    expect(patched).toContain(
      "$strapiRoutes = fn (\\Illuminate\\Http\\Request $request): bool => $request->is('api', 'api/*', 'graphql');",
    );
    expect(patched).toContain("$middleware->trimStrings(except: [$strapiRoutes]);");
    expect(patched).toContain("$middleware->convertEmptyStringsToNull(except: [$strapiRoutes]);");
  });
  it("is idempotent", () => {
    const once = patchBootstrapMiddleware(STOCK_BOOTSTRAP);
    expect(patchBootstrapMiddleware(once)).toBe(once);
  });
  it("leaves a customised withMiddleware unchanged so the caller can fail loudly", () => {
    const hand = STOCK_BOOTSTRAP.replace(
      "        //\n",
      "        $middleware->trustProxies(at: '*');\n",
    );
    expect(patchBootstrapMiddleware(hand)).toBe(hand);
  });
});

// Strapi serves GraphQL at /graphql, beside /api, so its route file is loaded on its own, inside
// withRouting so that route:cache keeps it; a project generated without GraphQL has no such file.
describe("patchBootstrapGraphql", () => {
  it("loads routes/graphql.php in the api middleware group when the file exists", () => {
    const patched = patchBootstrapGraphql(STOCK_BOOTSTRAP);
    expect(patched).toContain("then: function (): void {");
    expect(patched).toContain("if (is_file(__DIR__.'/../routes/graphql.php')) {");
    expect(patched).toContain(
      "\\Illuminate\\Support\\Facades\\Route::middleware('api')->group(__DIR__.'/../routes/graphql.php');",
    );
    expect(patched).toContain("health: '/up',");
  });
  it("is idempotent", () => {
    const once = patchBootstrapGraphql(STOCK_BOOTSTRAP);
    expect(patchBootstrapGraphql(once)).toBe(once);
  });
  it("leaves a bootstrap without the stock health route unchanged so the caller can fail loudly", () => {
    const hand = STOCK_BOOTSTRAP.replace("        health: '/up',\n", "");
    expect(patchBootstrapGraphql(hand)).toBe(hand);
  });
});

// Strapi's transfer runner is /admin/transfer/runner/*, outside /api; its route file is loaded the
// same way, in the one `then` callback GraphQL's may already have opened.
describe("patchBootstrapTransfer", () => {
  const loads = (source: string, file: string) =>
    source.includes(
      `\\Illuminate\\Support\\Facades\\Route::middleware('api')->group(__DIR__.'/../routes/${file}');`,
    );
  it("loads routes/transfer.php in the api middleware group when the file exists", () => {
    const patched = patchBootstrapTransfer(STOCK_BOOTSTRAP);
    expect(patched).toContain("if (is_file(__DIR__.'/../routes/transfer.php')) {");
    expect(loads(patched, "transfer.php")).toBe(true);
  });
  it("shares one then callback with GraphQL, whichever is patched first", () => {
    for (const patched of [
      patchBootstrapTransfer(patchBootstrapGraphql(STOCK_BOOTSTRAP)),
      patchBootstrapGraphql(patchBootstrapTransfer(STOCK_BOOTSTRAP)),
    ]) {
      expect(patched.split("then: function").length).toBe(2);
      expect(loads(patched, "transfer.php")).toBe(true);
      expect(loads(patched, "graphql.php")).toBe(true);
    }
  });
  it("is idempotent", () => {
    const once = patchBootstrapTransfer(STOCK_BOOTSTRAP);
    expect(patchBootstrapTransfer(once)).toBe(once);
  });
  it("leaves a bootstrap without the stock health route unchanged so the caller can fail loudly", () => {
    const hand = STOCK_BOOTSTRAP.replace("        health: '/up',\n", "");
    expect(patchBootstrapTransfer(hand)).toBe(hand);
  });
});

const STOCK_CONSOLE = `<?php

use Illuminate\\Foundation\\Inspiring;
use Illuminate\\Support\\Facades\\Artisan;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');
`;

describe("patchConsoleRoutes", () => {
  it("loads the generated routes/schedule.php when there is one", () => {
    const patched = patchConsoleRoutes(STOCK_CONSOLE);
    expect(patched.startsWith(STOCK_CONSOLE)).toBe(true);
    expect(patched).toContain(`if (is_file(__DIR__.'/schedule.php')) {
    require __DIR__.'/schedule.php';
}`);
  });
  it("is idempotent", () => {
    const once = patchConsoleRoutes(STOCK_CONSOLE);
    expect(patchConsoleRoutes(once)).toBe(once);
  });
});

describe("scaffoldCommand", () => {
  it("loads the IR's schedules from routes/console.php, on either storage layout", async () => {
    for (const storage of ["laravel", "strapi"] as const) {
      const { io, written } = fakeIo({
        files: {
          "/proj/app/app/Models/User.php": STOCK_USER,
          "/proj/app/app/Providers/Filament/AdminPanelProvider.php": STOCK_PANEL,
          "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP,
          "/proj/app/routes/console.php": STOCK_CONSOLE,
        },
      });
      expect(await scaffoldCommand("filament", "app", io, { storage })).toBe(0);
      expect(written["/proj/app/routes/console.php"]).toBe(patchConsoleRoutes(STOCK_CONSOLE));
    }
  });

  it("creates the app's parent directory before composer runs in it", async () => {
    // `camis new` scaffolds into generated/filament before generated/ exists; spawning composer
    // with a missing cwd fails with ENOENT.
    const { io, calls, madeDirs } = fakeIo({
      files: {
        "/proj/generated/filament/app/Models/User.php": STOCK_USER,
        "/proj/generated/filament/app/Providers/Filament/AdminPanelProvider.php": STOCK_PANEL,
        "/proj/generated/filament/bootstrap/app.php": STOCK_BOOTSTRAP,
      },
    });
    expect(await scaffoldCommand("filament", "generated/filament", io)).toBe(0);
    expect(madeDirs).toEqual(["/proj/generated"]);
    expect(calls[0]!.cwd).toBe("/proj/generated");
  });

  it("installs webonyx/graphql-php and routes /graphql with --graphql", async () => {
    const { io, calls, written } = fakeIo({
      files: {
        "/proj/app/app/Models/User.php": STOCK_USER,
        "/proj/app/app/Providers/Filament/AdminPanelProvider.php": STOCK_PANEL,
        "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP,
      },
    });
    expect(await scaffoldCommand("filament", "app", io, { graphql: true })).toBe(0);
    expect(calls.at(-1)!.args).toEqual([
      "require",
      "webonyx/graphql-php:^15.19",
      "--no-interaction",
    ]);
    expect(written["/proj/app/bootstrap/app.php"]).toContain("routes/graphql.php");
  });

  it("routes Strapi's transfer runner on every scaffold", async () => {
    const { io, written } = fakeIo({
      files: {
        "/proj/app/app/Models/User.php": STOCK_USER,
        "/proj/app/app/Providers/Filament/AdminPanelProvider.php": STOCK_PANEL,
        "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP,
      },
    });
    expect(await scaffoldCommand("filament", "app", io)).toBe(0);
    expect(written["/proj/app/bootstrap/app.php"]).toContain("routes/transfer.php");
  });

  it("runs the composer/artisan sequence in order and patches User.php", async () => {
    const { io, calls, written } = fakeIo({
      files: {
        "/proj/app/app/Models/User.php": STOCK_USER,
        "/proj/app/app/Providers/Filament/AdminPanelProvider.php": STOCK_PANEL,
        "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP,
      },
    });
    const code = await scaffoldCommand("filament", "app", io);
    expect(code).toBe(0);
    expect(written["/proj/app/bootstrap/app.php"]).toContain("prependToGroup('api'");
    expect(written["/proj/app/bootstrap/app.php"]).toContain("Integration::handles($exceptions);");
    expect(calls.map((c) => `${c.cmd} ${c.args[0] ?? ""}`.trim())).toEqual([
      "composer create-project",
      "composer require",
      "php artisan",
      "php artisan",
      "composer require",
      "php artisan",
    ]);
    expect(calls[0]!.args).toContain("laravel/laravel:^12");
    expect(calls[0]!.cwd).toBe("/proj");
    expect(calls[1]!.args).toContain("filament/filament:^5.0");
    expect(calls[1]!.cwd).toBe("/proj/app");
    expect(calls[2]!.args).toEqual(["artisan", "filament:install", "--panels", "--no-interaction"]);
    expect(calls[3]!.args).toEqual(["artisan", "install:api", "--no-interaction"]);
    expect(calls[4]!.args).toContain("spatie/laravel-permission");
    expect(calls[5]!.args.join(" ")).toContain("vendor:publish");
    expect(written["/proj/app/app/Models/User.php"]).toContain("HasRoles");
    expect(written["/proj/app/app/Providers/Filament/AdminPanelProvider.php"]).toContain(
      "->authGuard('admin')",
    );
  });

  it("fails when the admin panel has no stock ->login() line", async () => {
    const { io, lines } = fakeIo({
      files: {
        "/proj/app/app/Models/User.php": STOCK_USER,
        "/proj/app/app/Providers/Filament/AdminPanelProvider.php": STOCK_PANEL.replace(
          "->login()",
          "->login(CustomLogin::class)",
        ),
        "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP,
      },
    });
    expect(await scaffoldCommand("filament", "app", io)).toBe(1);
    expect(lines.join("\n")).toContain("admin panel");
  });

  it("refuses a directory that already has composer.json", async () => {
    const { io, calls, lines } = fakeIo({
      files: { "/proj/app/composer.json": "{}" },
    });
    const code = await scaffoldCommand("filament", "app", io);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toContain("already");
  });

  it("aborts on the first failing step", async () => {
    const { io, calls } = fakeIo({ execResults: [0, 1] });
    const code = await scaffoldCommand("filament", "app", io);
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
  });

  // A User model whose trait line has been hand-edited matches nothing; writing it back unchanged
  // would report success and leave an app that cannot issue Sanctum tokens.
  it("fails when the User model matches no known trait line", async () => {
    const unrecognised = STOCK_USER.replace(
      "use HasFactory, Notifiable;",
      "use HasFactory, Notifiable, SomeOtherTrait;",
    );
    const { io, lines, written } = fakeIo({
      files: {
        "/proj/app/app/Models/User.php": unrecognised,
        "/proj/app/app/Providers/Filament/AdminPanelProvider.php": STOCK_PANEL,
        "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP,
      },
    });
    const code = await scaffoldCommand("filament", "app", io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("✗");
    expect(lines.join("\n")).toContain("app/Models/User.php");
    expect(written["/proj/app/app/Models/User.php"]).toBeUndefined();
  });

  it("rejects unknown scaffold targets", async () => {
    const { io, lines } = fakeIo({});
    const code = await scaffoldCommand("strapi", "app", io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("filament");
  });
});

describe("scaffoldCommand — storage strapi", () => {
  it("runs only the two composer steps and never touches User.php", async () => {
    const { io, calls, written } = fakeIo({
      files: { "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP },
    });
    const code = await scaffoldCommand("filament", "app", io, { storage: "strapi" });
    expect(code).toBe(0);
    expect(written["/proj/app/bootstrap/app.php"]).toContain("prependToGroup('api'");
    expect(calls).toEqual([
      {
        cmd: "composer",
        args: ["create-project", "laravel/laravel:^12", "/proj/app", "--no-interaction"],
        cwd: "/proj",
      },
      {
        cmd: "composer",
        args: ["require", "firebase/php-jwt", "visus/cuid2", "--no-interaction"],
        cwd: "/proj/app",
      },
    ]);
    expect(written["/proj/app/app/Models/User.php"]).toBeUndefined();
    expect(written["/proj/app/bootstrap/app.php"]).toContain("api: __DIR__.'/../routes/api.php',");
  });

  it("fails when bootstrap/app.php cannot be patched, rather than leaving dead api routes", async () => {
    const { io, lines, written } = fakeIo({
      files: {
        "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP.replace(
          "commands: __DIR__.'/../routes/console.php',",
          "",
        ),
      },
    });
    const code = await scaffoldCommand("filament", "app", io, { storage: "strapi" });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("bootstrap/app.php");
    expect(written["/proj/app/bootstrap/app.php"]).toBeUndefined();
  });

  it("aborts on the first failing step and never reaches the second", async () => {
    const { io, calls } = fakeIo({ execResults: [1] });
    const code = await scaffoldCommand("filament", "app", io, { storage: "strapi" });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("still refuses a directory that already has composer.json", async () => {
    const { io, calls, lines } = fakeIo({
      files: { "/proj/app/composer.json": "{}" },
    });
    const code = await scaffoldCommand("filament", "app", io, { storage: "strapi" });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toContain("already");
  });

  it("defaults to the laravel sequence (unchanged) when storage is omitted", async () => {
    const { io, calls } = fakeIo({
      files: {
        "/proj/app/app/Models/User.php": STOCK_USER,
        "/proj/app/app/Providers/Filament/AdminPanelProvider.php": STOCK_PANEL,
        "/proj/app/bootstrap/app.php": STOCK_BOOTSTRAP,
      },
    });
    const code = await scaffoldCommand("filament", "app", io);
    expect(code).toBe(0);
    expect(calls).toHaveLength(6);
  });
});
