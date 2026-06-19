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
import { emitHookFiles } from "./hooks/emit";
import { kebab, strapiNames } from "./names";
import { emitPermissions } from "./permissions/emit";
import { contentTypeSchema } from "./schema";
import { synthesizedInverses } from "./relations";
import { skeletonFiles } from "./skeleton";

const typeFiles = (ct: ContentType, extraAttributes: Record<string, unknown>): GeneratedFile[] => {
  const names = strapiNames(ct);
  return [
    {
      path: `src/api/${names.singularName}/content-types/${names.singularName}/schema.json`,
      content: stableJson(contentTypeSchema(ct, extraAttributes)),
    },
    ...apiFactoryFiles(names),
  ];
};

const componentFile = (component: Component): GeneratedFile => ({
  path: `src/components/shared/${kebab(component.name)}.json`,
  content: stableJson(componentSchema(component)),
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

const dynamicZoneGaps = (doc: IrDocument): CapabilityGap[] =>
  doc.contentTypes.flatMap((ct) =>
    ct.fields
      .filter((f) => f.type === "dynamicZone")
      .map(
        (f): CapabilityGap => ({
          feature: "dynamicZone",
          location: { contentType: ct.name, field: f.name },
          severity: "downgrade",
          message: `dynamicZone is not supported yet; "${ct.name}.${f.name}" is dropped.`,
        }),
      ),
  );

export const strapiAdapter: GenerateAdapter = {
  target: "strapi",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const inverses = synthesizedInverses(doc);
    const files: GeneratedFile[] = [
      ...skeletonFiles(options.projectName),
      ...doc.contentTypes.flatMap((ct) => typeFiles(ct, inverses.get(ct.name) ?? {})),
      ...doc.components.map(componentFile),
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
        gaps: [...softDeleteGaps(doc), ...dynamicZoneGaps(doc), ...perm.gaps, ...aiGaps],
      },
    };
  },
};
