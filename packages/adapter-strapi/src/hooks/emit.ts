import type { GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { strapiNames } from "@camis/strapi-schema";
import { emitHookContract } from "./contract";
import { emitHookLifecycles } from "./lifecycles";
import { hookSlug } from "./names";
import { emitHookStub } from "./stub";

export const emitHookFiles = (doc: IrDocument): GeneratedFile[] => {
  const hooks = doc.hooks ?? [];
  const files: GeneratedFile[] = [];
  for (const h of hooks) {
    const slug = hookSlug(h.name);
    files.push({ path: `src/hooks/contracts/${slug}.contract.ts`, content: emitHookContract(h) });
    files.push({ path: `src/hooks/${slug}.ts`, content: emitHookStub(h), mode: "seed" });
  }
  for (const ct of doc.contentTypes) {
    const own = hooks.filter((h) => h.contentType === ct.name);
    if (own.length === 0) continue;
    const names = strapiNames(ct);
    files.push({
      path: `src/api/${names.singularName}/content-types/${names.singularName}/lifecycles.ts`,
      content: emitHookLifecycles(own, names.uid),
    });
  }
  return files;
};
