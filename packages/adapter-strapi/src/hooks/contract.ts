import { withMarker } from "@camis/adapter-kernel";
import type { Hook, ShapeField } from "@camis/ir-schema";
import { TS_TYPE } from "./names";

const iface = (name: string, fields: ShapeField[]): string =>
  `export interface ${name} {\n${fields.map((f) => `  ${f.name}: ${TS_TYPE[f.type]};`).join("\n")}\n}`;

export const emitHookContract = (h: Hook): string =>
  withMarker(
    `${iface(`${h.name}Input`, h.input)}\n\n${iface(`${h.name}Output`, h.output)}\n\nexport interface ${h.name}Hook {\n  run(input: ${h.name}Input): ${h.name}Output;\n}\n`,
  );
