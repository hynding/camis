import {
  buildManifest,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { expressNames } from "./names";
import { emitRoutes } from "./routes";
import { emitSchema } from "./schema";
import { skeletonFiles } from "./skeleton";

export const expressAdapter: GenerateAdapter = {
  target: "express",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const gaps: CapabilityGap[] = [];
    const files: GeneratedFile[] = [...skeletonFiles(doc, options.projectName)];

    const schemas = doc.contentTypes.map((ct) => emitSchema(ct)).join("\n");
    files.push({ path: "src/db/schema.ts", content: schemas });

    for (const ct of doc.contentTypes) {
      for (const f of ct.fields) {
        if (!isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Express target`,
          });
        }
      }
      files.push({ path: `src/routes/${expressNames(ct).table}.ts`, content: emitRoutes(ct) });
    }

    return { files, manifest: buildManifest(files), gaps: { target: "express", gaps } };
  },
};
