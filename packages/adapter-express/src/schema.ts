import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { DIALECTS, type Dialect } from "./dialect";
import { column, isSupportedField } from "./fields";
import { expressNames } from "./names";
import type { ResolvedRelations } from "./relations";

// A single `schema.ts` is ONE ES module, so it must carry exactly one import block — re-importing
// `integer`/`text`/etc. per table would be a duplicate-declaration error. emitSchemaFile collects
// every table's imports into one statement and emits all tables, relation blocks, and pivot tables.
export const emitSchemaFile = (
  cts: ContentType[],
  dialect: Dialect,
  rel: ResolvedRelations,
): string => {
  const spec = DIALECTS[dialect];
  const fkImport = dialect === "mysql" ? "int" : "integer";
  const ts1 = spec.timestamp("created_at");
  const ts2 = spec.timestamp("updated_at");
  const importNames = new Set<string>([spec.tableFn, ...spec.idImports, ts1.import, ts2.import]);
  let hasRelations = false;
  const blocks: string[] = [];

  for (const ct of cts) {
    const n = expressNames(ct);
    const cols = ct.fields.filter((f) => isSupportedField(f.type)).map((f) => column(dialect, f));
    cols.forEach((c) => importNames.add(c.import));
    const fk = rel.fkColumns.get(ct.name) ?? [];
    if (fk.length > 0) importNames.add(fkImport);
    const colLines = cols.map((c) => `  ${c.column}: ${c.drizzle},`).join("\n");
    const body = [colLines, fk.join("\n")].filter((s) => s.length > 0).join("\n");
    blocks.push(`export const ${n.table} = ${spec.tableFn}("${n.table}", {
  ${spec.idColumn},
${body}
  createdAt: ${ts1.expr},
  updatedAt: ${ts2.expr},
});`);
    const relBlocks = rel.relationBlocks.get(ct.name);
    if (relBlocks && relBlocks.length > 0) {
      hasRelations = true;
      blocks.push(`export const ${n.table}Relations = relations(${n.table}, ({ one, many }) => ({
${relBlocks.join("\n")}
}));`);
    }
  }

  for (const [key, lines] of rel.fkColumns) {
    if (!key.startsWith("__pivot__")) continue;
    importNames.add(fkImport);
    const name = key.slice("__pivot__".length);
    blocks.push(`export const ${name} = ${spec.tableFn}("${name}", {
${lines.join("\n")}
});`);
  }

  const imports = [...importNames].sort().join(", ");
  const relImport = hasRelations ? `\nimport { relations } from "drizzle-orm";` : "";
  return withMarker(`import { ${imports} } from "${spec.core}";${relImport}

${blocks.join("\n\n")}
`);
};
