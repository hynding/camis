import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { expressNames, snakeColumn } from "./names";

export interface RouteOptions {
  secured?: boolean;
}

export const emitRoutes = (
  ct: ContentType,
  fkColumns: string[] = [],
  options: RouteOptions = {},
): string => {
  const n = expressNames(ct);
  const t = n.table;
  const typeName = ct.name;
  const cols = [
    ...ct.fields.filter((f) => isSupportedField(f.type)).map((f) => snakeColumn(f.name)),
    ...fkColumns,
  ]
    .map((c) => `"${c}"`)
    .join(", ");

  if (!options.secured) {
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
  }

  return withMarker(`import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ${t} } from "../db/schema";
import { authorizeAction, recordAllowed, filterRead, stripWrites, roleOf } from "../permissions/enforce";

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

export const ${t}Router = Router();

${t}Router.get("/", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "read")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const all = db.select().from(${t}).all().filter((row) => recordAllowed(req, "${typeName}", row));
  const sort = String(req.query._sort ?? "id");
  const order = String(req.query._order ?? "ASC").toUpperCase() === "DESC" ? -1 : 1;
  all.sort((a, b) => (a[sort as keyof typeof a] > b[sort as keyof typeof b] ? order : -order));
  const start = Number(req.query._start ?? 0);
  const end = Number(req.query._end ?? all.length);
  const page = all.slice(start, end).map((row) => filterRead(req, "${typeName}", row));
  res.setHeader("Content-Range", \`${t} \${start}-\${Math.max(start, end - 1)}/\${all.length}\`);
  res.json(page);
});

${t}Router.get("/:id", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "read")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const row = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!row || !recordAllowed(req, "${typeName}", row)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(filterRead(req, "${typeName}", row));
});

${t}Router.post("/", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "create")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const proposed = pick(req.body, [${cols}]);
  const data = stripWrites(req, "${typeName}", proposed, proposed);
  const row = db.insert(${t}).values(data).returning().get();
  res.status(201).json(filterRead(req, "${typeName}", row));
});

${t}Router.patch("/:id", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "update")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const existing = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!existing || !recordAllowed(req, "${typeName}", existing)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const incoming = pick(req.body, [${cols}]);
  const data = stripWrites(req, "${typeName}", { ...existing, ...incoming }, incoming);
  const row = db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get();
  res.json(filterRead(req, "${typeName}", row));
});

${t}Router.delete("/:id", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "delete")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const existing = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!existing || !recordAllowed(req, "${typeName}", existing)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  db.delete(${t}).where(eq(${t}.id, Number(req.params.id))).run();
  res.json({ id: Number(req.params.id) });
});
`);
};
