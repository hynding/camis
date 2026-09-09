import { columnField, withMarker, type ExpandedContentType } from "@camis/adapter-kernel";
import type { ContentType, Field } from "@camis/ir-schema";
import { DIALECTS, type Dialect } from "./dialect";
import { column, isSupportedField } from "./fields";
import { expressNames, snakeColumn } from "./names";
import type { ResolvedRelations } from "./relations";

const snakePath = (path: string[]): string => path.map(snakeColumn).join("_");

const camelPath = (path: string[]): string =>
  path.map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1))).join("");

// A single `schema.ts` is ONE ES module, so it must carry exactly one import block — re-importing
// `integer`/`text`/etc. per table would be a duplicate-declaration error. emitSchemaFile collects
// every table's imports into one statement and emits all tables, relation blocks, and pivot tables.
export const emitSchemaFile = (
  cts: ContentType[],
  dialect: Dialect,
  rel: ResolvedRelations,
  expansions: ReadonlyMap<string, ExpandedContentType> = new Map(),
): string => {
  const spec = DIALECTS[dialect];
  const fkImport = dialect === "mysql" ? "int" : "integer";
  const ts1 = spec.timestamp("created_at");
  const ts2 = spec.timestamp("updated_at");
  const importNames = new Set<string>([spec.tableFn, ...spec.idImports, ts1.import, ts2.import]);
  let hasRelations = false;
  const blocks: string[] = [];

  const childBlocks: string[] = [];
  for (const ct of cts) {
    const n = expressNames(ct);
    const expansion = expansions.get(ct.name);
    // A shared embedded column is NOT NULL only when the component is always present;
    // `s.field.required` alone still speaks for validation, not for the column.
    const embedded = (expansion?.scalars ?? []).map((s) =>
      column(dialect, { ...columnField(s), name: snakePath(s.path) } as Field),
    );
    const cols = [
      ...ct.fields.filter((f) => isSupportedField(f.type)).map((f) => column(dialect, f)),
      ...embedded,
    ];
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
    const childRel: string[] = [];
    for (const t of expansion?.tables ?? []) {
      const childTable = `${n.table}_${snakePath(t.path)}`;
      const fkCol = `${snakeColumn(ct.name)}_id`;
      importNames.add(fkImport);
      const childCols = t.scalars.map((s) =>
        column(dialect, { ...columnField(s), name: snakePath(s.path) } as Field),
      );
      childCols.forEach((c) => importNames.add(c.import));
      const childColLines = childCols.map((c) => `  ${c.column}: ${c.drizzle},`).join("\n");
      const fkExpr = dialect === "mysql" ? `int('${fkCol}')` : `integer('${fkCol}')`;
      childBlocks.push(`export const ${childTable} = ${spec.tableFn}("${childTable}", {
  ${spec.idColumn},
  ${fkCol}: ${fkExpr}.references(() => ${n.table}.id),
${childColLines}
});`);
      childBlocks.push(`export const ${childTable}Relations = relations(${childTable}, ({ one }) => ({
  ${snakeColumn(ct.name)}: one(${n.table}, { fields: [${childTable}.${fkCol}], references: [${n.table}.id] }),
}));`);
      childRel.push(`  ${camelPath(t.path)}: many(${childTable}),`);
      hasRelations = true;
    }
    const relBlocks = [...(rel.relationBlocks.get(ct.name) ?? []), ...childRel];
    if (relBlocks.length > 0) {
      hasRelations = true;
      blocks.push(`export const ${n.table}Relations = relations(${n.table}, ({ one, many }) => ({
${relBlocks.join("\n")}
}));`);
    }
  }
  blocks.push(...childBlocks);

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
