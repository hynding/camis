import {
  buildManifest,
  withMarker,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { DIALECTS, type Dialect } from "./dialect";
import { isSupportedField } from "./fields";
import { camisSchemaFile } from "./import";
import { expressNames } from "./names";
import { resolveRelations } from "./relations";
import { emitRoutes } from "./routes";
import { emitSchema } from "./schema";
import { skeletonFiles } from "./skeleton";

// "  author_id: integer('author_id').references(...)," → "author_id"
const fkNames = (lines: string[]): string[] => lines.map((l) => l.trim().split(":")[0]!.trim());

// A manyToMany junction table (resolveRelations surfaces its two FK lines under a __pivot__ key).
const emitPivot = (dialect: Dialect, name: string, lines: string[]): string => {
  const spec = DIALECTS[dialect];
  const imp = dialect === "mysql" ? "int" : "integer";
  return withMarker(`import { ${imp}, ${spec.tableFn} } from "${spec.core}";

export const ${name} = ${spec.tableFn}("${name}", {
${lines.join("\n")}
});
`);
};

export const expressAdapterFor = (dialect: Dialect): GenerateAdapter => ({
  target: "express",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const rel = resolveRelations(doc, dialect);
    const gaps: CapabilityGap[] = [];
    const files: GeneratedFile[] = [...skeletonFiles(doc, options.projectName, dialect)];

    const schemaParts: string[] = [];
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
      const blocks = rel.relationBlocks.get(ct.name);
      const relationBlock =
        blocks && blocks.length > 0
          ? `export const ${expressNames(ct).table}Relations = relations(${expressNames(ct).table}, ({ one, many }) => ({\n${blocks.join("\n")}\n}));`
          : undefined;
      schemaParts.push(
        emitSchema(ct, dialect, { fkColumns: fk, ...(relationBlock ? { relationBlock } : {}) }),
      );
      files.push({
        path: `src/routes/${expressNames(ct).table}.ts`,
        content: emitRoutes(ct, fkNames(fk)),
      });
    });

    for (const [key, lines] of rel.fkColumns) {
      if (!key.startsWith("__pivot__")) continue;
      schemaParts.push(emitPivot(dialect, key.slice("__pivot__".length), lines));
    }

    files.push({ path: "src/db/schema.ts", content: schemaParts.join("\n") });
    files.push(camisSchemaFile(doc));

    return { files, manifest: buildManifest(files), gaps: { target: "express", gaps } };
  },
});

export const expressAdapter = expressAdapterFor("sqlite");
