import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Io } from "./io";

export const targetConfig = z.object({
  target: z.enum(["express", "strapi", "filament"]),
  out: z.string().min(1),
  projectName: z.string().optional(),
  dialect: z.enum(["sqlite", "mysql", "pgsql"]).optional(),
  apiStyle: z.enum(["laravel", "strapi"]).optional(),
  storageLayout: z.enum(["laravel", "strapi"]).optional(),
  alwaysPopulateComponents: z.boolean().optional(),
  graphql: z.boolean().optional(),
});
export type TargetConfig = z.infer<typeof targetConfig>;

export const projectConfig = z.object({
  ir: z.string().min(1),
  roles: z.string().min(1).optional(),
  /** Directory mirrored into every target's `out` after generation (hand-written seams). */
  protected: z.string().min(1).optional(),
  targets: z.array(targetConfig).min(1),
});
export type ProjectConfig = z.infer<typeof projectConfig>;

export type LoadResult = { ok: true; value: ProjectConfig } | { ok: false; error: string };

export const loadConfig = async (io: Io, configPath: string): Promise<LoadResult> => {
  const abs = isAbsolute(configPath) ? configPath : resolve(io.cwd, configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await io.readFile(abs));
  } catch (e) {
    return { ok: false, error: `cannot read config ${configPath}: ${(e as Error).message}` };
  }
  const parsed = projectConfig.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  for (const [i, t] of parsed.data.targets.entries()) {
    if (t.storageLayout === "strapi" && t.apiStyle !== "strapi") {
      return {
        ok: false,
        error: `targets.${i}: storageLayout "strapi" requires apiStyle "strapi"`,
      };
    }
  }

  const base = dirname(abs);
  const value: ProjectConfig = {
    ir: resolve(base, parsed.data.ir),
    ...(parsed.data.roles !== undefined ? { roles: resolve(base, parsed.data.roles) } : {}),
    ...(parsed.data.protected !== undefined
      ? { protected: resolve(base, parsed.data.protected) }
      : {}),
    targets: parsed.data.targets.map((t) => ({ ...t, out: resolve(base, t.out) })),
  };
  return { ok: true, value };
};
