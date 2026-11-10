import { fileURLToPath } from "node:url";
import type { Io } from "./io";
import { developCommand } from "./commands/develop";
import { generateCommand } from "./commands/generate";
import { importCommand } from "./commands/import";
import { newCommand } from "./commands/new";
import { scaffoldCommand } from "./commands/scaffold";
import { validateCommand } from "./commands/validate";

const USAGE = `camis — content-model build tool

Usage:
  camis new <dir> [--template vanilla|example | --from-strapi <strapiProjectDir>
                  [--roles-from <strapiExport.tar.gz[.enc]> [--key <key>]]
                  [--admin-roles-from <strapi .tmp/data.db>]]
                  [--targets strapi,filament,express] [--dialect sqlite|mysql|pgsql]
                  [--skip-scaffold] [--skip-build]
                                                 (create a project, then scaffold and build it)
  camis validate <ir.json>
  camis import <strapi|express> <projectDir> [--out ir.json] [--upsert-by <field>]
               [--roles-from <strapiExport.tar.gz[.enc]> [--key <key>]]
               [--admin-roles-from <strapi .tmp/data.db>] [--roles-out roles.json]
               [--env-out deployment.env]  (Strapi: the Laravel env for its upload/email providers)
  camis scaffold filament <dir> [--storage laravel|strapi] [--graphql]
                                                 (create the Laravel host app for the overlay)
  camis generate [--config camis.config.json]   (dry-run: lists files + gaps)
  camis build    [--config camis.config.json]   (writes the project to each out)
  camis develop  [--config camis.config.json] [--no-serve]
                                                 (build, let the admin's Content-Type Builder edit
                                                  the content model, and serve the Filament app)`;

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
      const rolesFrom = optionalFlag(rest, "--roles-from");
      const adminRolesFrom = optionalFlag(rest, "--admin-roles-from");
      const key = optionalFlag(rest, "--key");
      return newCommand(rest[0], io, {
        ...(adminRolesFrom !== undefined ? { strapiAdminRoles: adminRolesFrom } : {}),
        ...(template !== undefined ? { template } : {}),
        ...(targets !== undefined ? { targets: targets.split(",") } : {}),
        ...(dialect !== undefined ? { dialect } : {}),
        ...(fromStrapi !== undefined ? { fromStrapi } : {}),
        ...(rolesFrom !== undefined
          ? { strapiRoles: { archive: rolesFrom, ...(key !== undefined ? { key } : {}) } }
          : {}),
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
      const rolesFrom = optionalFlag(rest, "--roles-from");
      const key = optionalFlag(rest, "--key");
      const envOut = optionalFlag(rest, "--env-out");
      const adminRolesFrom = optionalFlag(rest, "--admin-roles-from");
      const rolesOut = optionalFlag(rest, "--roles-out");
      return importCommand(rest[0], rest[1], flag(rest, "--out", "camis.json"), io, {
        ...(adminRolesFrom !== undefined ? { adminRoles: adminRolesFrom } : {}),
        ...(rolesOut !== undefined ? { rolesOut } : {}),
        ...(upsertBy ? { upsertBy } : {}),
        ...(envOut !== undefined ? { envOut } : {}),
        ...(rolesFrom !== undefined
          ? {
              roles: {
                archive: rolesFrom,
                out: flag(rest, "--roles-out", "roles.json"),
                ...(key !== undefined ? { key } : {}),
              },
            }
          : {}),
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
      return scaffoldCommand(rest[0], rest[1], io, {
        storage,
        graphql: rest.includes("--graphql"),
      });
    }
    case "generate":
      return generateCommand(flag(rest, "--config", "camis.config.json"), io, { write: false });
    case "build":
      return generateCommand(flag(rest, "--config", "camis.config.json"), io, { write: true });
    case "develop":
      return developCommand(flag(rest, "--config", "camis.config.json"), io, {
        node: process.execPath,
        bin: fileURLToPath(new URL("../bin/camis.mjs", import.meta.url)),
        serve: !rest.includes("--no-serve"),
      });
    default:
      io.out(USAGE);
      return cmd === "help" || cmd === "--help" ? 0 : 1;
  }
};
