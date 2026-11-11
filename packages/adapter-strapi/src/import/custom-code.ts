import { TS_MARKER } from "@camis/adapter-kernel";
import type { CapabilityGap } from "@camis/ir-schema";

/** A file of a Strapi project, with the path relative to the project. */
export interface ProjectFile {
  path: string;
  content: string;
}

// Strapi's JavaScript and TypeScript, and strapi-php's PHP, which keeps Strapi's layout file for file.
const CODE = /\.(?:[cm]?js|jsx|ts|tsx|php)$/;

// What each kind of custom code is, and where its behavior goes in camis.
const MESSAGES = {
  customController:
    "controller code is not imported; port it by hand into the target's custom routes (Filament: routes/api-custom.php)",
  customService:
    "service code is not imported; port it by hand beside the custom routes that call it",
  customRoutes:
    "custom routes are not imported; port them by hand into the target's custom routes (Filament: routes/api-custom.php)",
  customPolicy:
    "policy code is not imported; declare it in the IR's policies and port its code into the seeded policy class",
  customMiddleware:
    "middleware code is not imported; declare a route middleware in the IR's middlewares and port its code into the seeded class (an app-wide one in config/middlewares is not covered)",
  lifecycles:
    "lifecycle code is not imported; declare each lifecycle as an IR hook (beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete or afterDelete) and port its code into the seeded hook class",
  cronTasks:
    "cron tasks are not imported; declare each as an IR schedule with its rule (five fields: drop a leading seconds field) and port its code into the seeded task class",
  bootstrap:
    "register() and bootstrap() code is not imported; port it by hand (Filament: a service provider)",
  pluginExtension: "a plugin extension is not imported; port it by hand",
  localPlugin: "a local plugin is not imported; port it by hand",
  adminCustomization: "admin panel customizations are not imported; camis's admin is its own",
  customCode: "hand-written code is not imported; port it by hand",
} as const;
type Feature = keyof typeof MESSAGES;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// What is left of a module once its imports, requires, PHP preamble and strict-mode pragma are gone.
const body = (source: string): string =>
  stripComments(source)
    .replace(/<\?php/, "")
    .replace(/declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;/, "")
    .replace(/^\s*use\s+[\w\\]+(?:\s+as\s+\w+)?\s*;/gm, "")
    .replace(/(["'])use strict\1;?/g, "")
    .replace(/import\s[^;]*?from\s*(["'])[^"']+\1;?/g, "")
    .replace(/const\s*\{[^}]*\}\s*=\s*require\([^)]*\)(?:\.\w+)*;?/g, "");

// The one-line factory a new Strapi API is generated with: the core controller, service or router.
const DEFAULT_FACTORY =
  /^(?:export\s+default|module\.exports\s*=|return)\s*(?:factories\.|Factories::)?createCore(?:Controller|Service|Router)\(\s*(["'`])[^"'`]+\1\s*\)\s*;?$/;
const isDefaultFactory = (source: string): boolean => DEFAULT_FACTORY.test(body(source).trim());

// A new project's src/index: empty register() and bootstrap(), as methods or (PHP) closures.
const EMPTY_LIFECYCLE =
  /(?:(["'])(?:register|bootstrap)\1\s*=>\s*(?:static\s+)?function|(?:async\s+)?(?:register|bootstrap))\s*\([^)]*\)\s*(?::\s*\??\w+\s*)?\{\s*\}/g;
const isDefaultIndex = (source: string): boolean =>
  body(source)
    .replace(EMPTY_LIFECYCLE, "")
    .replace(/export\s+default|module\.exports\s*=|return|[\s{}[\],;]/g, "") === "";

const classify = (path: string, content: string): Feature | undefined => {
  if (/^config\/(?:.+\/)?cron-tasks\.\w+$/.test(path)) return "cronTasks";
  if (/^config\/server\.\w+$/.test(path))
    return /cron["']?\s*(?::|=>)\s*[[{][\s\S]*tasks["']?\s*(?::|=>)\s*[[{]/.test(
      stripComments(content),
    )
      ? "cronTasks"
      : undefined;
  if (path.startsWith("config/")) return undefined;
  if (/^src\/(?:api\/[^/]+\/)?index\.\w+$/.test(path))
    return isDefaultIndex(content) ? undefined : "bootstrap";
  if (path.startsWith("src/extensions/")) return "pluginExtension";
  if (path.startsWith("src/admin/"))
    return /\.example\.\w+$/.test(path) ? undefined : "adminCustomization";
  if (/^src\/(?:api\/[^/]+\/)?policies\//.test(path)) return "customPolicy";
  if (/^src\/(?:api\/[^/]+\/)?middlewares\//.test(path)) return "customMiddleware";
  if (/^src\/api\/[^/]+\/content-types\/[^/]+\/lifecycles\.\w+$/.test(path)) return "lifecycles";
  const api = /^src\/api\/[^/]+\/(controllers|services|routes)\//.exec(path);
  if (api === null) return "customCode";
  if (isDefaultFactory(content)) return undefined;
  if (api[1] === "controllers") return "customController";
  if (api[1] === "services") return "customService";
  // A core router's options are read by importRouters, which reports what it cannot carry.
  return /createCoreRouter\s*\(/.test(content) ? undefined : "customRoutes";
};

const gap = (feature: Feature, file: string): CapabilityGap => ({
  feature,
  location: { file },
  severity: "downgrade",
  message: MESSAGES[feature],
});

/**
 * Each file of hand-written code in a Strapi project, which an import cannot carry over: the IR
 * comes only from declarative files. Files a new project starts with, and files camis generated,
 * are passed over. A local plugin is one gap, named by its directory.
 */
export const customCodeGaps = (files: ProjectFile[]): CapabilityGap[] => {
  const gaps: CapabilityGap[] = [];
  const plugins = new Set<string>();
  for (const { path, content } of files) {
    const plugin = /^src\/plugins\/[^/]+/.exec(path);
    if (plugin !== null) {
      plugins.add(plugin[0]);
      continue;
    }
    if (!CODE.test(path) || content.startsWith(TS_MARKER)) continue;
    const feature = classify(path, content);
    if (feature !== undefined) gaps.push(gap(feature, path));
  }
  gaps.push(...[...plugins].map((dir) => gap("localPlugin", dir)));
  return gaps.sort((a, b) => ((a.location.file ?? "") < (b.location.file ?? "") ? -1 : 1));
};
