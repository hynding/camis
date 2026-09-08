import { isAbsolute, dirname, join, resolve } from "node:path";
import type { Io } from "../io";

const STOCK_TRAIT_USE = "use HasFactory, Notifiable;";
const ROLES_ONLY_TRAIT_USE = "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles;";
const PATCHED_TRAIT_USE =
  "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles, \\Laravel\\Sanctum\\HasApiTokens;";

/**
 * Add Spatie's HasRoles and Sanctum's HasApiTokens to the Laravel User model. Idempotent.
 *
 * Handles the roles-only form as well as the stock one: an app already patched by the non-strapi
 * boot path has HasRoles but no HasApiTokens, and returning it unchanged would leave an app that
 * cannot issue Sanctum tokens. A source matching neither is returned unchanged; the caller treats
 * that as a failure rather than reporting a patch that never happened.
 */
export const patchUserModel = (source: string): string => {
  if (source.includes("HasApiTokens")) return source;
  if (source.includes(ROLES_ONLY_TRAIT_USE)) {
    return source.replace(ROLES_ONLY_TRAIT_USE, PATCHED_TRAIT_USE);
  }
  return source.replace(STOCK_TRAIT_USE, PATCHED_TRAIT_USE);
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

export const scaffoldCommand = async (target: string, dir: string, io: Io): Promise<number> => {
  if (target !== "filament") {
    io.out(`✗ "${target}" has no scaffold; only the filament target needs a host app`);
    return 1;
  }
  const appDir = isAbsolute(dir) ? dir : resolve(io.cwd, dir);
  try {
    await io.readFile(join(appDir, "composer.json"));
    io.out(`✗ ${dir} already contains a composer project; refusing to scaffold over it`);
    return 1;
  } catch {
    // no composer.json → safe to scaffold
  }

  for (const step of steps(appDir, dirname(appDir), appDir)) {
    io.out(`→ ${step.cmd} ${step.args.join(" ")}`);
    const code = await io.exec(step.cmd, step.args, step.cwd);
    if (code !== 0) {
      io.out(`✗ ${step.cmd} ${step.args.join(" ")} exited ${code}`);
      return 1;
    }
  }

  const userModelPath = join(appDir, "app/Models/User.php");
  try {
    const source = await io.readFile(userModelPath);
    const patched = patchUserModel(source);
    if (patched === source && !source.includes("HasApiTokens")) {
      io.out(
        "✗ could not patch app/Models/User.php: no recognised `use HasFactory, Notifiable…` trait line",
      );
      return 1;
    }
    await io.writeFile(userModelPath, patched);
    io.out("✓ patched app/Models/User.php with Spatie HasRoles and Sanctum HasApiTokens");
  } catch (e) {
    io.out(`✗ cannot patch ${userModelPath}: ${(e as Error).message}`);
    return 1;
  }

  io.out(`✓ scaffolded Laravel 12 + Filament v5 + Spatie at ${dir}`);
  io.out(`  next: point a filament target's "out" at ${dir} and run: camis build`);
  return 0;
};
