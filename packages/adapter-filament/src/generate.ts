import {
  buildManifest,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { emitMigration, migrationFilename } from "./migration";
import { emitModel } from "./model";
import { filamentNames } from "./names";
import { emitResourceFiles } from "./resource";

export const filamentAdapter: GenerateAdapter = {
  target: "filament",
  generate: (ir): GenerationResult => {
    const doc = normalize(ir.document);
    const files: GeneratedFile[] = [];
    const gaps: CapabilityGap[] = [];

    doc.contentTypes.forEach((ct, i) => {
      for (const f of ct.fields) {
        if (f.type !== "relation" && !isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Filament target`,
          });
        }
      }
      const names = filamentNames(ct);
      files.push({ path: `app/Models/${names.model}.php`, content: emitModel(ct) });
      files.push({ path: migrationFilename(ct, i + 1), content: emitMigration(ct) });
      files.push(...emitResourceFiles(ct));
    });

    return { files, manifest: buildManifest(files), gaps: { target: "filament", gaps } };
  },
};
