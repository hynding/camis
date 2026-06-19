import {
  buildManifest,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { aiFieldContentTypes, aiProviderFile, emitAiObserver, hasAiField } from "./ai";
import { isSupportedField } from "./fields";
import { emitHookFiles } from "./hooks/emit";
import { emitPermissions } from "./permissions/emit";
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
    const hooks = emitHookFiles(doc);
    const files: GeneratedFile[] = [];
    const gaps: CapabilityGap[] = [];

    const aiObservedModels = new Set<string>();
    const aiGenFiles: GeneratedFile[] = [];
    const aiGaps: CapabilityGap[] = [];
    if (hasAiField(doc)) {
      aiGenFiles.push(aiProviderFile());
      for (const ct of aiFieldContentTypes(doc)) {
        if (hooks.observedModels.has(ct.name)) {
          aiGaps.push({
            feature: "aiHookCollision",
            location: { contentType: ct.name },
            severity: "downgrade",
            message: `"${ct.name}" has both a hook and an AI field; both target the model observer. The hook observer wins; AI generation is not wired for this type.`,
          });
          continue;
        }
        aiObservedModels.add(ct.name);
        aiGenFiles.push({
          path: `app/Observers/${filamentNames(ct).model}Observer.php`,
          content: emitAiObserver(ct),
        });
      }
    }

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
        content: emitModel(
          ct,
          rel.methods.get(ct.name) ?? [],
          hooks.observedModels.has(ct.name) || aiObservedModels.has(ct.name),
        ),
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

    const perm = emitPermissions(doc, ir.roles);
    const allFiles = [...files, ...hooks.files, ...perm.files, ...aiGenFiles];
    return {
      files: allFiles,
      manifest: buildManifest(allFiles),
      gaps: { target: "filament", gaps: [...gaps, ...perm.gaps, ...aiGaps] },
    };
  },
};
