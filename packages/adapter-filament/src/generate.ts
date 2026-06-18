import {
  buildManifest,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import {
  emitMigration,
  emitPivotMigration,
  migrationFilename,
  pivotMigrationFilename,
} from "./migration";
import { emitModel } from "./model";
import { filamentNames } from "./names";
import { resolveRelations } from "./relations";
import { emitResourceFiles } from "./resource";

export const filamentAdapter: GenerateAdapter = {
  target: "filament",
  generate: (ir): GenerationResult => {
    const doc = normalize(ir.document);
    const rel = resolveRelations(doc);
    const files: GeneratedFile[] = [];
    const gaps: CapabilityGap[] = [];

    doc.contentTypes.forEach((ct, i) => {
      for (const f of ct.fields) {
        if (f.type === "relation") continue;
        if (!isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Filament target`,
          });
        }
      }
      const names = filamentNames(ct);
      files.push({
        path: `app/Models/${names.model}.php`,
        content: emitModel(ct, rel.methods.get(ct.name) ?? []),
      });
      files.push({
        path: migrationFilename(ct, i + 1),
        content: emitMigration(ct, rel.fkColumns.get(ct.name) ?? []),
      });
      files.push(...emitResourceFiles(ct, rel.formFields.get(ct.name) ?? []));
    });

    [...rel.pivots]
      .sort((a, b) => a.table.localeCompare(b.table))
      .forEach((p, j) => {
        files.push({
          path: pivotMigrationFilename(p, doc.contentTypes.length + 1 + j),
          content: emitPivotMigration(p),
        });
      });

    return { files, manifest: buildManifest(files), gaps: { target: "filament", gaps } };
  },
};
