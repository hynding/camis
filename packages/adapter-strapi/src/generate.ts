import {
  buildManifest,
  stableJson,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import { apiFactoryFiles } from "./api-files";
import { strapiNames } from "./names";
import { contentTypeSchema } from "./schema";
import { skeletonFiles } from "./skeleton";

const typeFiles = (ct: ContentType): GeneratedFile[] => {
  const names = strapiNames(ct);
  return [
    {
      path: `src/api/${names.singularName}/content-types/${names.singularName}/schema.json`,
      content: stableJson(contentTypeSchema(ct)),
    },
    ...apiFactoryFiles(names),
  ];
};

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
  generate: (input: IrDocument, options): GenerationResult => {
    const doc = normalize(input);
    const files: GeneratedFile[] = [
      ...skeletonFiles(options.projectName),
      ...doc.contentTypes.flatMap(typeFiles),
    ];
    return {
      files,
      manifest: buildManifest(files),
      gaps: { target: "strapi", gaps: softDeleteGaps(doc) },
    };
  },
};
