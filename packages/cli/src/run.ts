import type { Io } from "./io";
import { generateCommand } from "./commands/generate";
import { importCommand } from "./commands/import";
import { newCommand } from "./commands/new";
import { scaffoldCommand } from "./commands/scaffold";
import { validateCommand } from "./commands/validate";

const USAGE = `camis — content-model build tool

Usage:
  camis new <dir> [--template vanilla|example | --from-strapi <strapiProjectDir>]
                  [--targets strapi,filament,express] [--dialect sqlite|mysql|pgsql]
                  [--skip-scaffold] [--skip-build]
                                                 (create a project, then scaffold and build it)
  camis validate <ir.json>
  camis import <strapi|express> <projectDir> [--out ir.json] [--upsert-by <field>]
  camis scaffold filament <dir> [--storage laravel|strapi]
                                                 (create the Laravel host app for the overlay)
  camis generate [--config camis.config.json]   (dry-run: lists files + gaps)
  camis build    [--config camis.config.json]   (writes the project to each out)`;

const flag = (args: string[], name: string, fallback: string): string => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v ?? fallback;
};

const optionalFlag = (args: string[], name: string): string | undefined => {
  const value = flag(args, name, "");
  return value === "" ? undefined : value;
};

export const run = async (argv: string[], io: Io): Promise<number> => {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "new": {
      if (!rest[0] || rest[0].startsWith("--")) {
        io.out("✗ new needs <dir>");
        return 1;
      }
      const template = optionalFlag(rest, "--template");
      const targets = optionalFlag(rest, "--targets");
      const dialect = optionalFlag(rest, "--dialect");
      const fromStrapi = optionalFlag(rest, "--from-strapi");
      return newCommand(rest[0], io, {
        ...(template !== undefined ? { template } : {}),
        ...(targets !== undefined ? { targets: targets.split(",") } : {}),
        ...(dialect !== undefined ? { dialect } : {}),
        ...(fromStrapi !== undefined ? { fromStrapi } : {}),
        skipScaffold: rest.includes("--skip-scaffold"),
        skipBuild: rest.includes("--skip-build"),
      });
    }
    case "validate": {
      if (!rest[0]) {
        io.out("✗ validate needs <ir.json>");
        return 1;
      }
      return validateCommand(rest[0], io);
    }
    case "import": {
      if (!rest[0] || !rest[1]) {
        io.out("✗ import needs <target> <projectDir>");
        return 1;
      }
      const upsertBy = flag(rest, "--upsert-by", "");
      return importCommand(rest[0], rest[1], flag(rest, "--out", "camis.json"), io, {
        ...(upsertBy ? { upsertBy } : {}),
      });
    }
    case "scaffold": {
      if (!rest[0] || !rest[1]) {
        io.out("✗ scaffold needs <target> <dir>");
        return 1;
      }
      const storage = flag(rest, "--storage", "laravel");
      if (storage !== "laravel" && storage !== "strapi") {
        io.out("✗ scaffold --storage must be laravel or strapi");
        return 1;
      }
      return scaffoldCommand(rest[0], rest[1], io, { storage });
    }
    case "generate":
      return generateCommand(flag(rest, "--config", "camis.config.json"), io, { write: false });
    case "build":
      return generateCommand(flag(rest, "--config", "camis.config.json"), io, { write: true });
    default:
      io.out(USAGE);
      return cmd === "help" || cmd === "--help" ? 0 : 1;
  }
};
