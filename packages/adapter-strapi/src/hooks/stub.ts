import type { Hook } from "@camis/ir-schema";
import { hookSlug } from "./names";

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

// Protected hand-written stub (seed mode, NO generated marker).
export const emitHookStub = (h: Hook): string =>
  `import type { ${h.name}Hook } from "./contracts/${hookSlug(h.name)}.contract";

// Ring 2 hook — hand-written. camis seeds this once and never overwrites it.
export const ${lower(h.name)}: ${h.name}Hook = {
  run(input) {
    // TODO: implement the behavior for "${h.name}".
    return input;
  },
};
`;
