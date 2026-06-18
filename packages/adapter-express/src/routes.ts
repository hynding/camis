import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { expressNames, snakeColumn } from "./names";

export const emitRoutes = (ct: ContentType): string => {
  const n = expressNames(ct);
  const t = n.table;
  const cols = ct.fields
    .filter((f) => isSupportedField(f.type))
    .map((f) => `"${snakeColumn(f.name)}"`)
    .join(", ");
  return withMarker(`import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ${t} } from "../db/schema";

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

export const ${t}Router = Router();

${t}Router.get("/", (_req, res) => {
  res.json(db.select().from(${t}).all());
});

${t}Router.get("/:id", (req, res) => {
  const row = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

${t}Router.post("/", (req, res) => {
  const data = pick(req.body, [${cols}]);
  const row = db.insert(${t}).values(data).returning().get();
  res.status(201).json(row);
});

${t}Router.patch("/:id", (req, res) => {
  const data = pick(req.body, [${cols}]);
  const row = db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

${t}Router.delete("/:id", (req, res) => {
  db.delete(${t}).where(eq(${t}.id, Number(req.params.id))).run();
  res.status(204).end();
});
`);
};
