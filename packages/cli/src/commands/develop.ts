import { isAbsolute, join, resolve } from "node:path";
import type { Io } from "../io";
import { loadConfig } from "../config";
import { generateCommand } from "./generate";

export interface DevelopOptions {
  /** The Node binary the app runs `camis build` with. */
  node: string;
  /** camis's bin script. */
  bin: string;
  /** Serve the app with `php artisan serve` once it is ready. */
  serve: boolean;
}

// Bare when it can be: phpdotenv reads a value holding single quotes in ways a shell would not.
const shellQuoted = (value: string): string =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `"${value.replace(/["$`\\]/g, "\\$&")}"`;

/**
 * The `.env` lines that let the admin's Content-Type Builder edit: where the project config is
 * (it names the content model and roles), and the command that rebuilds every target from it.
 */
export const developEnv = (paths: {
  project: string;
  node: string;
  bin: string;
}): Record<string, string> => ({
  CAMIS_PROJECT_CONFIG: paths.project,
  CAMIS_BUILD_COMMAND: `${shellQuoted(paths.node)} ${shellQuoted(paths.bin)} build --config ${shellQuoted(paths.project)}`,
});

/** Set each variable in a `.env` source, in place where it is set already. Idempotent. */
export const patchDevelopEnv = (source: string, env: Record<string, string>): string => {
  let patched = source === "" || source.endsWith("\n") ? source : `${source}\n`;
  for (const [key, value] of Object.entries(env)) {
    const line = `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const existing = new RegExp(`^${key}=.*$`, "m");
    patched = existing.test(patched)
      ? patched.replace(existing, () => line)
      : `${patched}${line}\n`;
  }
  return patched;
};

/**
 * `camis develop`, as `strapi develop`: build the project, let the Strapi-style Filament app's
 * Content-Type Builder edit the content model (APP_ENV=local, which a new Laravel app has), bring
 * its database up to the build, and serve it.
 */
export const developCommand = async (
  configPath: string,
  io: Io,
  options: DevelopOptions,
): Promise<number> => {
  const cfg = await loadConfig(io, configPath);
  if (!cfg.ok) {
    io.out(`✗ config: ${cfg.error}`);
    return 1;
  }
  const app = cfg.value.targets.find(
    (t) => t.target === "filament" && t.apiStyle === "strapi" && t.storageLayout !== "strapi",
  );
  if (app === undefined) {
    io.out(
      '✗ develop needs a filament target with apiStyle "strapi" (and the laravel storage layout): its admin has the Content-Type Builder',
    );
    return 1;
  }
  if ((await generateCommand(configPath, io, { write: true })) !== 0) return 1;

  const project = isAbsolute(configPath) ? configPath : resolve(io.cwd, configPath);
  const envPath = join(app.out, ".env");
  const source = await io.readFile(envPath).catch(() => "");
  await io.writeFile(
    envPath,
    patchDevelopEnv(source, developEnv({ project, node: options.node, bin: options.bin })),
  );
  io.out(`✓ the Content-Type Builder in ${app.out} edits ${cfg.value.ir}`);

  if ((await io.exec("php", ["artisan", "camis:schema-sync"], app.out)) !== 0) {
    io.out("✗ php artisan camis:schema-sync failed");
    return 1;
  }
  if (!options.serve) return 0;
  return io.exec("php", ["artisan", "serve"], app.out);
};
