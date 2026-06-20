import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Io } from "./io";

export const targetConfig = z.object({
  target: z.enum(["express", "strapi", "filament"]),
  out: z.string().min(1),
  projectName: z.string().optional(),
  dialect: z.enum(["sqlite", "mysql", "pgsql"]).optional(),
});
export type TargetConfig = z.infer<typeof targetConfig>;

export const projectConfig = z.object({
  ir: z.string().min(1),
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
  const base = dirname(abs);
  const value: ProjectConfig = {
    ir: resolve(base, parsed.data.ir),
    targets: parsed.data.targets.map((t) => ({ ...t, out: resolve(base, t.out) })),
  };
  return { ok: true, value };
};
