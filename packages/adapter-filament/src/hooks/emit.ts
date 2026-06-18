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
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const files: GeneratedFile[] = [];
  const observedModels = new Set<string>();
  for (const h of doc.hooks ?? []) {
    const ct = byName.get(h.contentType);
    if (!ct) continue;
    files.push({ path: `app/Hooks/Contracts/${h.name}Hook.php`, content: emitHookContract(h) });
    files.push({ path: `app/Hooks/${h.name}.php`, content: emitHookStub(h), mode: "seed" });
    files.push({
      path: `app/Observers/${filamentNames(ct).model}Observer.php`,
      content: emitHookObserver(h, ct),
    });
    observedModels.add(h.contentType);
  }
  return { files, observedModels };
};
