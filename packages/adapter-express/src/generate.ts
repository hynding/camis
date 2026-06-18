import {
  buildManifest,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { type Dialect } from "./dialect";
import { isSupportedField } from "./fields";
import { camisSchemaFile } from "./import";
import { expressNames } from "./names";
import { resolveRelations } from "./relations";
import { emitRoutes } from "./routes";
import { emitSchemaFile } from "./schema";
import { skeletonFiles } from "./skeleton";

// "  author_id: integer('author_id').references(...)," → "author_id"
const fkNames = (lines: string[]): string[] => lines.map((l) => l.trim().split(":")[0]!.trim());

export const expressAdapterFor = (dialect: Dialect): GenerateAdapter => ({
  target: "express",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const rel = resolveRelations(doc, dialect);
    const gaps: CapabilityGap[] = [];
    const files: GeneratedFile[] = [...skeletonFiles(doc, options.projectName, dialect)];

    doc.contentTypes.forEach((ct) => {
      for (const f of ct.fields) {
        if (f.type === "relation") continue;
        if (!isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Express target`,
          });
        }
      }
      const fk = rel.fkColumns.get(ct.name) ?? [];
      files.push({
        path: `src/routes/${expressNames(ct).table}.ts`,
        content: emitRoutes(ct, fkNames(fk)),
      });
    });

    files.push({
      path: "src/db/schema.ts",
      content: emitSchemaFile(doc.contentTypes, dialect, rel),
    });
    files.push(camisSchemaFile(doc));

    return { files, manifest: buildManifest(files), gaps: { target: "express", gaps } };
  },
});

export const expressAdapter = expressAdapterFor("sqlite");
