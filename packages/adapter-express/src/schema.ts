import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { column, isSupportedField } from "./fields";
import { expressNames } from "./names";

export const emitSchema = (ct: ContentType): string => {
  const n = expressNames(ct);
  // Only supported scalar fields become columns; unsupported types are gapped in generate.ts.
  const cols = ct.fields.filter((f) => isSupportedField(f.type)).map((f) => column("sqlite", f));
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
