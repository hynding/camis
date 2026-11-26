import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { isSupportedField } from "./fields";
import { maxLengths } from "./lengths";
import { expressNames, snakeColumn } from "./names";

export interface RouteOptions {
  secured?: boolean;
  aiColumns?: string[];
  /** The type's polymorphic links (`src/morphs.ts`): its own, only inverses read, or none. */
  links?: "own" | "inverse" | "none";
  /** The project's database, whose columns decide the length each bounded field is checked at. */
  dialect?: Dialect;
}

export const emitRoutes = (
  ct: ContentType,
  fkColumns: string[] = [],
  options: RouteOptions = {},
): string => {
  const n = expressNames(ct);
  const t = n.table;
  const typeName = ct.name;
  const aiSet = new Set(options.aiColumns ?? []);
  const cols = [
    ...ct.fields
      .filter((f) => isSupportedField(f.type))
      .map((f) => snakeColumn(f.name))
      .filter((c) => !aiSet.has(c)),
    ...fkColumns,
  ]
    .map((c) => `"${c}"`)
    .join(", ");

  const links = options.links ?? "none";
  const own = links === "own";
  const linkKeys = ct.fields
    .filter((f) => f.type === "polymorphicRelation")
    .map((f) => `, "${snakeColumn(f.name)}"`)
    .join("");
  const writable = own ? `${cols}${linkKeys}` : cols;

  const hasAi = aiSet.size > 0;
  const asyncKw = hasAi ? "async " : "";
  const dataDecl = hasAi ? "let" : "const";
  const aiImport = hasAi ? `\nimport { populateAiFields } from "../ai/populate";` : "";
  const createPop = hasAi
    ? `\n  data = await populateAiFields("${typeName}", data, "create");`
    : "";
  const updatePop = hasAi
    ? `\n  data = await populateAiFields("${typeName}", data, "update");`
    : "";

  const linkNames =
    links === "none"
      ? []
      : own
        ? ["checkLinks", "dropLinks", "linkColumns", "readLinks", "writeLinks", "type Allowed"]
        : ["readLinks", "type Allowed"];
  const linksImport =
    links === "none" ? "" : `\nimport { ${linkNames.join(", ")} } from "../morphs";`;
  // A body with a value longer than its field's bound is refused whole, before anything is written.
  const bounds = maxLengths(ct, options.aiColumns, options.dialect);
  const lengthsImport = bounds.length === 0 ? "" : `\nimport { tooLong } from "../lengths";`;
  const boundsConstant =
    bounds.length === 0
      ? ""
      : `\n/** Each bounded field's maxLength, in characters. */\nconst MAX_LENGTHS: Record<string, number> = { ${bounds.map(([c, n]) => `${c}: ${n}`).join(", ")} };\n`;
  const lengthCheck =
    bounds.length === 0
      ? ""
      : `
  const longer = tooLong(req.body, MAX_LENGTHS);
  if (longer !== null) {
    res.status(400).json({ error: longer });
    return;
  }`;
  // A body naming an entry the caller may not read (or that is not there) is refused whole.
  const refusal = (body: string, allowed: string) => `
  const refused = checkLinks("${typeName}", ${body}, ${allowed});
  if (refused !== null) {
    res.status(400).json({ error: refused });
    return;
  }`;
  // A write must leave a row the role's condition for it holds on: a create may not make, and an
  // update may not turn its row into, one the role could not have written.
  const forbidden = (action: string, row: string) => `
  if (!recordAllowed(req, "${typeName}", "${action}", ${row})) {
    res.status(403).json({ error: "forbidden" });
    return;
  }`;
  const createRefusal = forbidden("create", "data");
  const updateRefusal = forbidden("update", "{ ...existing, ...data }");
  const shown = (row: string) =>
    links === "none" ? `filterRead(req, "${typeName}", ${row})` : `view(req, ${row})`;

  if (!options.secured) {
    return withMarker(`import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ${t} } from "../db/schema";${aiImport}${linksImport}${lengthsImport}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
${boundsConstant}${links === "none" ? "" : `\n// Without grants every caller reads every entry a link names.\nconst allowed: Allowed = () => true;\n`}
export const ${t}Router = Router();

${t}Router.get("/", (_req, res) => {
  res.json(db.select().from(${t}).all()${links === "none" ? "" : `.map((row) => readLinks("${typeName}", row, allowed))`});
});

${t}Router.get("/:id", (req, res) => {
  const row = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(${links === "none" ? "row" : `readLinks("${typeName}", row, allowed)`});
});

${t}Router.post("/", ${asyncKw}(req, res) => {${lengthCheck}${
      own
        ? `
  const body = pick(req.body, [${writable}]);${refusal("body", "allowed")}
  ${dataDecl} data = linkColumns("${typeName}", body);${createPop}
  const row = db.insert(${t}).values(data).returning().get();
  writeLinks("${typeName}", row.id, body);
  res.status(201).json(readLinks("${typeName}", row, allowed));`
        : `
  ${dataDecl} data = pick(req.body, [${cols}]);${createPop}
  const row = db.insert(${t}).values(data).returning().get();
  res.status(201).json(${links === "none" ? "row" : `readLinks("${typeName}", row, allowed)`});`
    }
});

${t}Router.patch("/:id", ${asyncKw}(req, res) => {${lengthCheck}${
      own
        ? `
  const body = pick(req.body, [${writable}]);${refusal("body", "allowed")}
  ${dataDecl} data = linkColumns("${typeName}", body);${updatePop}
  const row =
    Object.keys(data).length > 0
      ? db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get()
      : db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  writeLinks("${typeName}", row.id, body);
  res.json(readLinks("${typeName}", row, allowed));`
        : `
  ${dataDecl} data = pick(req.body, [${cols}]);${updatePop}
  const row = db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(${links === "none" ? "row" : `readLinks("${typeName}", row, allowed)`});`
    }
});

${t}Router.delete("/:id", (req, res) => {${own ? `\n  dropLinks("${typeName}", Number(req.params.id));` : ""}
  db.delete(${t}).where(eq(${t}.id, Number(req.params.id))).run();
  res.status(204).end();
});
`);
  }

  return withMarker(`import { Router${links === "none" ? "" : ", type Request"} } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ${t} } from "../db/schema";
import {
  assignOwners,
  authorizeAction,
  filterRead,
  keepOwners,
  recordAllowed,
  roleOf,
  sortColumn,
  stripWrites,
} from "../permissions/enforce";${aiImport}${linksImport}${lengthsImport}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
${boundsConstant}${
    links === "none"
      ? ""
      : `
// A link names an entry the caller may read: its type's read grant, and its record condition.
const allowed =
  (req: Request): Allowed =>
  (type, row) =>
    authorizeAction(roleOf(req), type, "read") && recordAllowed(req, type, "read", row);

const view = (req: Request, row: Record<string, unknown>) =>
  filterRead(req, "${typeName}", readLinks("${typeName}", row, allowed(req)));
`
  }
export const ${t}Router = Router();

${t}Router.get("/", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "read")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const all = db.select().from(${t}).all().filter((row) => recordAllowed(req, "${typeName}", "read", row));
  const sort = sortColumn(req, "${typeName}", req.query._sort);
  const order = String(req.query._order ?? "ASC").toUpperCase() === "DESC" ? -1 : 1;
  all.sort((a, b) => (a[sort as keyof typeof a] > b[sort as keyof typeof b] ? order : -order));
  const start = Number(req.query._start ?? 0);
  const end = Number(req.query._end ?? all.length);
  const page = all.slice(start, end).map((row) => ${shown("row")});
  res.setHeader("Content-Range", \`${t} \${start}-\${Math.max(start, end - 1)}/\${all.length}\`);
  res.json(page);
});

${t}Router.get("/:id", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "read")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const row = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!row || !recordAllowed(req, "${typeName}", "read", row)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(${shown("row")});
});

${t}Router.post("/", ${asyncKw}(req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "create")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }${lengthCheck}
  const proposed = pick(req.body, [${writable}]);${
    own
      ? `
  const permitted = assignOwners(req, "${typeName}", stripWrites(req, "${typeName}", proposed, proposed));${refusal("permitted", "allowed(req)")}
  ${dataDecl} data = linkColumns("${typeName}", permitted);${createRefusal}${createPop}
  const row = db.insert(${t}).values(data).returning().get();
  writeLinks("${typeName}", row.id, permitted);`
      : `
  ${dataDecl} data = assignOwners(req, "${typeName}", stripWrites(req, "${typeName}", proposed, proposed));${createRefusal}${createPop}
  const row = db.insert(${t}).values(data).returning().get();`
  }
  res.status(201).json(${shown("row")});
});

${t}Router.patch("/:id", ${asyncKw}(req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "update")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }${lengthCheck}
  const existing = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!existing || !recordAllowed(req, "${typeName}", "update", existing)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const incoming = keepOwners(req, "${typeName}", pick(req.body, [${writable}]));${
    own
      ? `
  const permitted = stripWrites(req, "${typeName}", { ...existing, ...incoming }, incoming);${refusal("permitted", "allowed(req)")}
  ${dataDecl} data = linkColumns("${typeName}", permitted);${updateRefusal}${updatePop}
  const row =
    Object.keys(data).length > 0
      ? db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get()
      : existing;
  writeLinks("${typeName}", row.id, permitted);`
      : `
  ${dataDecl} data = stripWrites(req, "${typeName}", { ...existing, ...incoming }, incoming);${updateRefusal}${updatePop}
  const row = db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get();`
  }
  res.json(${shown("row")});
});

${t}Router.delete("/:id", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "delete")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const existing = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!existing || !recordAllowed(req, "${typeName}", "delete", existing)) {
    res.status(404).json({ error: "not found" });
    return;
  }
${own ? `  dropLinks("${typeName}", Number(req.params.id));\n` : ""}  db.delete(${t}).where(eq(${t}.id, Number(req.params.id))).run();
  res.json({ id: Number(req.params.id) });
});
`);
};
