import { isAbsolute, resolve } from "node:path";
import { validate } from "@camis/ir-core";
import type { IrErrorLocation } from "@camis/ir-schema";
import type { Io } from "../io";

export const locStr = (l: IrErrorLocation): string =>
  [l.contentType, l.component, l.field, l.rule].filter(Boolean).join(".") || "(document)";

export const validateCommand = async (irPath: string, io: Io): Promise<number> => {
  const abs = isAbsolute(irPath) ? irPath : resolve(io.cwd, irPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await io.readFile(abs));
  } catch (e) {
    io.out(`✗ cannot read ${irPath}: ${(e as Error).message}`);
    return 1;
  }
  const result = validate(raw);
  if (result.ok) {
    io.out(`✓ valid (${result.value.contentTypes.length} content types)`);
    return 0;
  }
  for (const e of result.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
  return 1;
};
