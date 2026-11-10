import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Io } from "../io";

/**
 * A Strapi project's config, run with an `env` that hands back a reference to each
 * variable it is asked for (`{ env, default }`, or `${NAME}` when spliced into text) instead of
 * its value: the settings come back as the project wrote them, and no secret is read.
 * A strapi-php project's PHP config runs under `php`, a Strapi project's JS or TS under `node`.
 * A function in the settings (a per-request option) comes back as `{}` from either.
 */
export type StrapiConfigRead =
  | { ok: true; config: Record<string, unknown> | unknown[] | undefined }
  | { ok: false; message: string };

const EXTENSIONS = ["php", "ts", "js", "mjs", "cjs"] as const;

// strapi-php's config closures take a Strapi\Utils\EnvHelper; this stands in for it, since the
// project's own autoloader is never loaded.
const PHP_READER = String.raw`
namespace Strapi\Utils;
final class CamisEnvReference implements \JsonSerializable
{
    public function __construct(private string $name, private mixed $default) {}
    public function jsonSerialize(): array
    {
        return is_scalar($this->default) ? ['env' => $this->name, 'default' => $this->default] : ['env' => $this->name];
    }
    public function __toString(): string
    {
        return '$' . '{' . $this->name . '}';
    }
}
final class EnvHelper
{
    public function __invoke(string $key, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
    public function get(string $key, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
    public function int(string $key, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
    public function float(string $key, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
    public function bool(string $key, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
    public function json(string $key, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
    public function array(string $key, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
    public function date(string $key, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
    public function oneOf(string $key, mixed $expected = null, mixed $default = null): mixed { return new CamisEnvReference($key, $default); }
}
$config = require $argv[1];
if ($config instanceof \Closure) {
    $config = $config(new EnvHelper());
}
echo json_encode($config, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
`;

const NODE_READER = `
import { pathToFileURL } from "node:url";
const reference = (name, fallback) => {
  const json = ["string", "number", "boolean"].includes(typeof fallback)
    ? { env: name, default: fallback }
    : { env: name };
  return { toJSON: () => json, toString: () => "\${" + name + "}" };
};
const env = Object.assign((key, fallback) => reference(key, fallback), {
  int: reference, float: reference, bool: reference, json: reference, array: reference,
  date: reference, oneOf: (key, expected, fallback) => reference(key, fallback),
});
const module = await import(pathToFileURL(process.argv[1]).href);
let config = module.default ?? module;
if (config !== null && typeof config === "object" && "default" in config) config = config.default;
if (typeof config === "function") config = await config({ env });
// As PHP's json_encode gives a closure, so both runtimes report a per-request option alike.
process.stdout.write(JSON.stringify(config ?? {}, (key, value) => typeof value === "function" ? {} : value));
`;

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** One of a Strapi project's config files (`config/<name>.php|ts|js|…`). */
export const readStrapiConfig = async (
  projectDir: string,
  name: string,
  capture: Io["capture"],
): Promise<StrapiConfigRead> => {
  let file: string | undefined;
  for (const extension of EXTENSIONS) {
    if (await exists(join(projectDir, "config", `${name}.${extension}`))) {
      file = `${name}.${extension}`;
      break;
    }
  }
  if (file === undefined) return { ok: true, config: undefined };
  const where = `config/${file}`;
  if (capture === undefined)
    return { ok: false, message: `${where} was not read: nothing may be run here` };
  const path = join(projectDir, "config", file);
  const [cmd, args] = file.endsWith(".php")
    ? ["php", ["-r", PHP_READER, path]]
    : [
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          "--input-type=module",
          "-e",
          NODE_READER,
          path,
        ],
      ];
  let ran: { code: number; stdout: string };
  try {
    ran = await capture(cmd, args as string[], projectDir);
  } catch (e) {
    return { ok: false, message: `${where} could not be read: ${(e as Error).message}` };
  }
  if (ran.code !== 0)
    return { ok: false, message: `${where} could not be read (exit ${ran.code})` };
  try {
    const config: unknown = JSON.parse(ran.stdout);
    return {
      ok: true,
      config:
        typeof config === "object" && config !== null
          ? (config as Record<string, unknown> | unknown[])
          : {},
    };
  } catch {
    return { ok: false, message: `${where} did not give back its settings` };
  }
};
