import type { GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { strapiNames } from "../names";
import { emitHookContract } from "./contract";
import { emitHookLifecycle } from "./lifecycles";
import { hookSlug } from "./names";
import { emitHookStub } from "./stub";

export const emitHookFiles = (doc: IrDocument): GeneratedFile[] => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const files: GeneratedFile[] = [];
  for (const h of doc.hooks ?? []) {
    const ct = byName.get(h.contentType);
    if (!ct) continue;
    const slug = hookSlug(h.name);
    files.push({ path: `src/hooks/contracts/${slug}.contract.ts`, content: emitHookContract(h) });
    files.push({ path: `src/hooks/${slug}.ts`, content: emitHookStub(h), mode: "seed" });
    const names = strapiNames(ct);
    files.push({
      path: `src/api/${names.singularName}/content-types/${names.singularName}/lifecycles.ts`,
      content: emitHookLifecycle(h),
    });
  }
  return files;
};
