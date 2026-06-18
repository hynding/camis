import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { emitColumn, isSupported8A } from "./fields";
import { expressNames } from "./names";

export const emitSchema = (ct: ContentType): string => {
  const n = expressNames(ct);
  // 8A: only supported scalar fields become columns; unsupported types are gapped in generate.ts.
  const cols = ct.fields.filter((f) => isSupported8A(f.type)).map(emitColumn);
  const imports = [...new Set(["sqliteTable", "integer", ...cols.map((c) => c.import)])]
    .sort()
    .join(", ");
  const colLines = cols.map((c) => `  ${c.column}: ${c.drizzle},`).join("\n");
  return withMarker(`import { ${imports} } from "drizzle-orm/sqlite-core";

export const ${n.table} = sqliteTable("${n.table}", {
  id: integer("id").primaryKey({ autoIncrement: true }),
${colLines}
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});
`);
};
