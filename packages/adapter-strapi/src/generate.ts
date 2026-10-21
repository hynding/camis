import {
  buildManifest,
  stableJson,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap, Component, ContentType, IrDocument } from "@camis/ir-schema";
import { aiFieldContentTypes, aiLifecycleFile, aiProviderFile, hasAiField } from "./ai";
import { apiFactoryFiles } from "./api-files";
import { componentSchema } from "./component-schema";
import { usersPermissionsExtensionFile } from "./extensions";
import { emitHookFiles } from "./hooks/emit";
import { componentCategory, componentUids, kebab, strapiNames } from "./names";
import { emitPermissions } from "./permissions/emit";
import { contentTypeSchema } from "./schema";
import { synthesizedInverses } from "./relations";
import { skeletonFiles } from "./skeleton";

const typeFiles = (
  ct: ContentType,
  extraAttributes: Record<string, unknown>,
  builtinUsers: ReadonlySet<string>,
  uids: ReadonlyMap<string, string>,
): GeneratedFile[] => {
  const names = strapiNames(ct);
  return [
    {
      path: `src/api/${names.singularName}/content-types/${names.singularName}/schema.json`,
      content: stableJson(contentTypeSchema(ct, extraAttributes, builtinUsers, uids)),
    },
    ...apiFactoryFiles(names),
  ];
};

const componentFile = (
  component: Component,
  builtinUsers: ReadonlySet<string>,
  uids: ReadonlyMap<string, string>,
): GeneratedFile => ({
  path: `src/components/${componentCategory(component)}/${kebab(component.name)}.json`,
  content: stableJson(componentSchema(component, builtinUsers, uids)),
});

const softDeleteGaps = (doc: IrDocument): CapabilityGap[] =>
  doc.contentTypes
    .filter((ct) => ct.options?.softDelete)
    .map(
      (ct): CapabilityGap => ({
        feature: "softDelete",
        location: { contentType: ct.name },
        severity: "downgrade",
        message: `Strapi has no native soft delete; "${ct.name}" softDelete is dropped.`,
      }),
    );

export const strapiAdapter: GenerateAdapter = {
  target: "strapi",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const inverses = synthesizedInverses(doc);
    const builtinUsers = new Set(
      doc.contentTypes.filter((ct) => ct.builtin === "user").map((ct) => ct.name),
    );
    const uids = componentUids(doc.components);
    // Inverses that land on a plugin content type have no schema.json of ours to live in.
    const userInverses = [...builtinUsers].reduce<Record<string, unknown>>(
      (acc, name) => ({ ...acc, ...(inverses.get(name) ?? {}) }),
      {},
    );
    const files: GeneratedFile[] = [
      ...skeletonFiles(options.projectName),
      ...doc.contentTypes
        .filter((ct) => ct.builtin === undefined)
        .flatMap((ct) => typeFiles(ct, inverses.get(ct.name) ?? {}, builtinUsers, uids)),
      ...doc.components.map((c) => componentFile(c, builtinUsers, uids)),
      ...(Object.keys(userInverses).length > 0
        ? [usersPermissionsExtensionFile(userInverses)]
        : []),
    ];
    const perm = emitPermissions(doc, ir.roles);
    const withPerm =
      perm.indexContent === undefined
        ? files
        : files.map((f) => (f.path === "src/index.ts" ? { ...f, content: perm.indexContent! } : f));
    const aiGenFiles: GeneratedFile[] = [];
    const aiGaps: CapabilityGap[] = [];
    if (hasAiField(doc)) {
      aiGenFiles.push(aiProviderFile());
      const hookCts = new Set((doc.hooks ?? []).map((h) => h.contentType));
      for (const ct of aiFieldContentTypes(doc)) {
        if (hookCts.has(ct.name)) {
          aiGaps.push({
            feature: "aiHookCollision",
            location: { contentType: ct.name },
            severity: "downgrade",
            message: `"${ct.name}" has both a hook and an AI field; both target lifecycles.ts. The hook lifecycle wins; AI generation is not wired for this type.`,
          });
          continue;
        }
        aiGenFiles.push(aiLifecycleFile(ct));
      }
    }
    const allFiles = [...withPerm, ...perm.files, ...emitHookFiles(doc), ...aiGenFiles];
    return {
      files: allFiles,
      manifest: buildManifest(allFiles),
      gaps: {
        target: "strapi",
        gaps: [...softDeleteGaps(doc), ...perm.gaps, ...aiGaps],
      },
    };
  },
};
