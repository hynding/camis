import { withMarker } from "@camis/adapter-kernel";
import type { Hook, ShapeField } from "@camis/ir-schema";
import { TS_TYPE } from "./names";

const iface = (name: string, fields: ShapeField[]): string =>
  `export interface ${name} {\n${fields.map((f) => `  ${f.name}: ${TS_TYPE[f.type]};`).join("\n")}\n}`;

export const emitHookContract = (h: Hook): string => {
  const returns = h.output.length > 0;
  return withMarker(
    [
      iface(`${h.name}Input`, h.input),
      ...(returns ? [iface(`${h.name}Output`, h.output)] : []),
      `export interface ${h.name}Hook {\n  run(input: ${h.name}Input): ${returns ? `${h.name}Output` : "void"};\n}\n`,
    ].join("\n\n"),
  );
};
