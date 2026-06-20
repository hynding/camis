import type { Io } from "./io";
import { generateCommand } from "./commands/generate";
import { importCommand } from "./commands/import";
import { validateCommand } from "./commands/validate";

const USAGE = `camis — content-model build tool

Usage:
  camis validate <ir.json>
  camis import <strapi|express> <projectDir> [--out ir.json]
  camis generate [--config camis.config.json]   (dry-run: lists files + gaps)
  camis build    [--config camis.config.json]   (writes the project to each out)`;

const flag = (args: string[], name: string, fallback: string): string => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v ?? fallback;
};

export const run = async (argv: string[], io: Io): Promise<number> => {
  const [cmd, ...rest] = argv;
  switch (cmd) {
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
      return importCommand(rest[0], rest[1], flag(rest, "--out", "camis.json"), io);
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
