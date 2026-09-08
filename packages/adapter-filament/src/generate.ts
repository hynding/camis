import {
  buildManifest,
  expandComponents,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { aiFieldContentTypes, aiProviderFile, emitAiObserver, hasAiField } from "./ai";
import {
  childMigrationFilename,
  childRelationMethod,
  childTableEmit,
  emitChildMigration,
  emitChildModel,
  repeaterComponent,
  type ChildTableEmit,
} from "./components";
import { apiCustomSeed, emitApiController, emitApiRoutes } from "./api";
import { deployFile } from "./deploy";
import { emitField, isSupportedField } from "./fields";
import { emitHookFiles } from "./hooks/emit";
import { emitPermissions } from "./permissions/emit";
import {
  emitMigration,
  emitPivotMigration,
  migrationFilename,
  pivotMigrationFilename,
} from "./migration";
import { emitModel } from "./model";
import { filamentNames, snakeColumn } from "./names";
import { resolveRelations } from "./relations";
import { emitResourceFiles } from "./resource";
import { emitStrapiApi } from "./strapi-api/emit";

export const filamentAdapter: GenerateAdapter = {
  target: "filament",
  generate: (ir, options): GenerationResult => {
    const apiStyle = options.apiStyle ?? "laravel";
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

    // Builtin content types (the target's native user model) map onto the stock Laravel
    // User/users table; the host app owns those files, so nothing is emitted for them.
    const emitted = doc.contentTypes.filter((ct) => ct.builtin === undefined);
    const strapi =
      apiStyle === "strapi"
        ? emitStrapiApi({ doc, bundle: ir, emitted, fkNames: rel.fkNames })
        : undefined;
    const children: { ct: (typeof emitted)[number]; child: ChildTableEmit }[] = [];
    emitted.forEach((ct, i) => {
      for (const f of ct.fields) {
        if (f.type === "relation" || f.type === "component") continue;
        if (!isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Filament target`,
          });
        }
      }
      const expansion = expandComponents(doc, ct);
      gaps.push(...expansion.gaps);
      const embeddedEmits = expansion.scalars.map((s) =>
        emitField(s.field, s.path.map(snakeColumn).join("_")),
      );
      const ctChildren = expansion.tables.map((t) => childTableEmit(ct, t));
      ctChildren.forEach((child) => children.push({ ct, child }));
      const names = filamentNames(ct);
      files.push({
        path: `app/Models/${names.model}.php`,
        content: emitModel(
          ct,
          [...(rel.methods.get(ct.name) ?? []), ...ctChildren.map(childRelationMethod)],
          hooks.observedModels.has(ct.name) || aiObservedModels.has(ct.name),
          embeddedEmits,
          rel.fkNames.get(ct.name) ?? [],
          strapi?.scopeMethods.get(ct.name) !== undefined
            ? [strapi.scopeMethods.get(ct.name)!]
            : [],
        ),
      });
      files.push({
        path: migrationFilename(ct, i + 1),
        content: emitMigration(ct, rel.fkColumns.get(ct.name) ?? [], embeddedEmits),
      });
      files.push(
        ...emitResourceFiles(
          ct,
          rel.formFields.get(ct.name) ?? [],
          embeddedEmits,
          ctChildren.map(repeaterComponent),
        ),
      );
      ctChildren.forEach((child) => {
        files.push({ path: `app/Models/${child.model}.php`, content: emitChildModel(child) });
      });
      if (apiStyle === "laravel") {
        files.push({
          path: `app/Http/Controllers/Api/${names.model}ApiController.php`,
          content: emitApiController(
            ct,
            [
              ...ct.fields
                .filter((f) => f.type !== "relation" && f.type !== "component")
                .map((f) => emitField(f).column),
              ...embeddedEmits.map((e) => e.column),
              ...(rel.fkNames.get(ct.name) ?? []),
            ],
            { secured: ir.roles.length > 0 },
          ),
        });
      }
    });

    if (strapi) {
      files.push(...strapi.files);
      gaps.push(...strapi.gaps);
    } else {
      files.push({
        path: "routes/api.php",
        content: emitApiRoutes(emitted, { secured: ir.roles.length > 0 }),
      });
    }
    files.push(apiCustomSeed());

    [...rel.pivots]
      .sort((a, b) => a.table.localeCompare(b.table))
      .forEach((p, j) => {
        files.push({
          path: pivotMigrationFilename(p, emitted.length + 1 + j),
          content: emitPivotMigration(p),
        });
      });

    [...children]
      .sort((a, b) => a.child.table.localeCompare(b.child.table))
      .forEach(({ ct, child }, k) => {
        files.push({
          path: childMigrationFilename(child, emitted.length + rel.pivots.length + 1 + k),
          content: emitChildMigration(ct, child),
        });
      });

    const perm = emitPermissions(doc, ir.roles);
    const allFiles = [...files, ...hooks.files, ...perm.files, ...aiGenFiles, deployFile()];
    return {
      files: allFiles,
      manifest: buildManifest(allFiles),
      gaps: { target: "filament", gaps: [...gaps, ...perm.gaps, ...aiGaps] },
    };
  },
};
