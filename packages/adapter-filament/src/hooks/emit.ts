import type { GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { filamentNames } from "../names";
import { emitHookContract } from "./contract";
import { emitHookObserver } from "./observer";
import { emitHookStub } from "./stub";

export interface HookEmission {
  files: GeneratedFile[];
  observedModels: Set<string>;
}

export const emitHookFiles = (doc: IrDocument): HookEmission => {
  const hooks = doc.hooks ?? [];
  const files: GeneratedFile[] = [];
  const observedModels = new Set<string>();
  for (const h of hooks) {
    files.push({ path: `app/Hooks/Contracts/${h.name}Hook.php`, content: emitHookContract(h) });
    files.push({ path: `app/Hooks/${h.name}.php`, content: emitHookStub(h), mode: "seed" });
  }
  for (const ct of doc.contentTypes) {
    const own = hooks.filter((h) => h.contentType === ct.name);
    if (own.length === 0) continue;
    files.push({
      path: `app/Observers/${filamentNames(ct).model}Observer.php`,
      content: emitHookObserver(own, ct),
    });
    observedModels.add(ct.name);
  }
  return { files, observedModels };
};
