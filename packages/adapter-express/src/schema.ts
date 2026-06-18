import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { DIALECTS, type Dialect } from "./dialect";
import { column, isSupportedField } from "./fields";
import { expressNames } from "./names";

export interface SchemaExtras {
  fkColumns: string[]; // pre-rendered FK column lines (from relations)
  relationBlock?: string; // a full `export const <table>Relations = relations(...)` block
}

export const emitSchema = (ct: ContentType, dialect: Dialect, extras: SchemaExtras): string => {
  const spec = DIALECTS[dialect];
  const n = expressNames(ct);
  const cols = ct.fields.filter((f) => isSupportedField(f.type)).map((f) => column(dialect, f));
  const ts1 = spec.timestamp("created_at");
  const ts2 = spec.timestamp("updated_at");
  const imports = [
    ...new Set([
      spec.tableFn,
      ...spec.idImports,
      ...cols.map((c) => c.import),
      ts1.import,
      ts2.import,
    ]),
  ]
    .sort()
    .join(", ");
  const colLines = cols.map((c) => `  ${c.column}: ${c.drizzle},`).join("\n");
  const fkLines = extras.fkColumns.join("\n");
  const body = [colLines, fkLines].filter((s) => s.length > 0).join("\n");
  const table = `export const ${n.table} = ${spec.tableFn}("${n.table}", {
  ${spec.idColumn},
${body}
  createdAt: ${ts1.expr},
  updatedAt: ${ts2.expr},
});`;
  const rel = extras.relationBlock ? `\n\n${extras.relationBlock}` : "";
  return withMarker(`import { ${imports} } from "${spec.core}";${extras.relationBlock ? `\nimport { relations } from "drizzle-orm";` : ""}

${table}${rel}
`);
};
