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
  // A row and its to-many links are written together or not at all (see `src/db/atomic.ts`).
  const atomicImport = own ? `\nimport { atomic } from "../db/atomic";` : "";
  // A body with a value longer than its field's bound is refused whole, before anything is written:
  // on a secured API, what the caller may write (see `permittedLengthCheck`).
  const bounds = maxLengths(ct, options.aiColumns, options.dialect);
  const lengthsImport = bounds.length === 0 ? "" : `\nimport { tooLong } from "../lengths";`;
  const boundsConstant =
    bounds.length === 0
      ? ""
      : `\n/** Each bounded field's maxLength, in characters. */\nconst MAX_LENGTHS: Record<string, number> = { ${bounds.map(([c, n]) => `${c}: ${n}`).join(", ")} };\n`;
  const checkLengths = (body: string) =>
    bounds.length === 0
      ? ""
      : `
  const longer = tooLong(${body}, MAX_LENGTHS);
  if (longer !== null) {
    res.status(400).json({ error: longer });
    return;
  }`;
  const lengthCheck = checkLengths("req.body");
  // After the record condition refuses a row the role could not have written (403) and the field
  // rules strip what it may not write, so a stripped field past its bound is no 400.
  const permittedLengthCheck = checkLengths("data");
  // A body naming an entry the caller may not read (or that is not there) is refused whole.
  const refusal = (body: string, allowed: string) => `
  const refused = await checkLinks("${typeName}", ${body}, ${allowed});
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
    links === "none" ? `filterRead(req, "${typeName}", ${row})` : `await view(req, ${row})`;
  const shownAll = (rows: string) =>
    links === "none"
      ? `${rows}.map((row) => filterRead(req, "${typeName}", row))`
      : `await Promise.all(${rows}.map((row) => view(req, row)))`;
  const readLinked = (row: string) =>
    links === "none" ? row : `await readLinks("${typeName}", ${row}, allowed)`;

  // Every database's client awaits a query; only an insert's id is dialect's own: MySQL has no
  // RETURNING, so drizzle answers the id from the insert's result there. No write returns its row on
  // MySQL, so each write reads it back on every database, which keeps the answers the same.
  const insertedId = (executor: string) =>
    `const [{ id }] = await ${executor}.insert(${t}).values(data)${
      options.dialect === "mysql" ? ".$returningId()" : `.returning({ id: ${t}.id })`
    };`;
  const update = (executor: string, indent: string) =>
    `if (Object.keys(data).length > 0)\n${indent}  await ${executor}.update(${t}).set(data).where(eq(${t}.id, id));`;
  const notFound = (condition: string) => `
  if (${condition}) {
    res.status(404).json({ error: "not found" });
    return;
  }`;
  const insert = (body: string) =>
    own
      ? `
  const id = await atomic(async (tx) => {
    ${insertedId("tx")}
    await writeLinks(tx, "${typeName}", id, ${body});
    return id;
  });`
      : `
  ${insertedId("db")}`;
  const write = (body: string) =>
    own
      ? `
  await atomic(async (tx) => {
    ${update("tx", "    ")}
    await writeLinks(tx, "${typeName}", id, ${body});
  });`
      : `
  ${update("db", "  ")}`;
  const remove = own
    ? `
  await atomic(async (tx) => {
    await dropLinks(tx, "${typeName}", id);
    await tx.delete(${t}).where(eq(${t}.id, id));
  });`
    : `
  await db.delete(${t}).where(eq(${t}.id, id));`;
  const readBack = `
  const row = await find(id);${notFound("!row")}`;

  const header = `import { asc, eq } from "drizzle-orm";
import { asyncRoute } from "../async-route";
import { db } from "../db/client";${atomicImport}
import { ${t} } from "../db/schema";`;
  const helpers = `function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

const find = async (id: number) =>
  (await db.select().from(${t}).where(eq(${t}.id, id)).limit(1))[0];
`;
  const listAll = `await db.select().from(${t}).orderBy(asc(${t}.id))`;
  // Only a numeric id reaches a route: PostgreSQL refuses to compare an integer with "abc".
  const byId = `"/:id(\\\\d+)"`;
  const route = (method: string, path: string, req: string, body: string) =>
    `${t}Router.${method}(${path}, asyncRoute(async (${req}, res) => {${body}
}));`;

  if (!options.secured) {
    const list =
      links === "none"
        ? `
  res.json(${listAll});`
        : `
  const rows = ${listAll};
  res.json(await Promise.all(rows.map((row) => readLinks("${typeName}", row, allowed))));`;
    const create = own
      ? `
  const body = pick(req.body, [${writable}]);${refusal("body", "allowed")}
  ${dataDecl} data = linkColumns("${typeName}", body);${createPop}${insert("body")}`
      : `
  ${dataDecl} data = pick(req.body, [${cols}]);${createPop}${insert("")}`;
    const patch = own
      ? `
  const id = Number(req.params.id);${notFound("!(await find(id))")}
  const body = pick(req.body, [${writable}]);${refusal("body", "allowed")}
  ${dataDecl} data = linkColumns("${typeName}", body);${updatePop}${write("body")}`
      : `
  const id = Number(req.params.id);
  ${dataDecl} data = pick(req.body, [${cols}]);${updatePop}${write("")}`;
    return withMarker(`import { Router } from "express";
${header}${aiImport}${linksImport}${lengthsImport}

${helpers}${boundsConstant}${links === "none" ? "" : `\n// Without grants every caller reads every entry a link names.\nconst allowed: Allowed = () => true;\n`}
export const ${t}Router = Router();

${route("get", `"/"`, "_req", list)}

${route(
  "get",
  byId,
  "req",
  `
  const row = await find(Number(req.params.id));${notFound("!row")}
  res.json(${readLinked("row")});`,
)}

${route(
  "post",
  `"/"`,
  "req",
  `${lengthCheck}${create}${readBack}
  res.status(201).json(${readLinked("row")});`,
)}

${route(
  "patch",
  byId,
  "req",
  `${lengthCheck}${patch}${readBack}
  res.json(${readLinked("row")});`,
)}

${route(
  "delete",
  byId,
  "req",
  `
  const id = Number(req.params.id);${remove}
  res.status(204).end();`,
)}
`);
  }

  const denied = (action: string) => `
  if (!authorizeAction(roleOf(req), "${typeName}", "${action}")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }`;
  const existing = (action: string) => `
  const id = Number(req.params.id);
  const existing = await find(id);${notFound(`!existing || !recordAllowed(req, "${typeName}", "${action}", existing)`)}`;
  const securedCreate = own
    ? `
  const permitted = assignOwners(req, "${typeName}", stripWrites(req, "${typeName}", proposed, proposed));${refusal("permitted", "allowed(req)")}
  ${dataDecl} data = linkColumns("${typeName}", permitted);${createRefusal}${permittedLengthCheck}${createPop}${insert("permitted")}`
    : `
  ${dataDecl} data = assignOwners(req, "${typeName}", stripWrites(req, "${typeName}", proposed, proposed));${createRefusal}${permittedLengthCheck}${createPop}${insert("")}`;
  const securedPatch = own
    ? `
  const permitted = stripWrites(req, "${typeName}", { ...existing, ...incoming }, incoming);${refusal("permitted", "allowed(req)")}
  ${dataDecl} data = linkColumns("${typeName}", permitted);${updateRefusal}${permittedLengthCheck}${updatePop}${write("permitted")}`
    : `
  ${dataDecl} data = stripWrites(req, "${typeName}", { ...existing, ...incoming }, incoming);${updateRefusal}${permittedLengthCheck}${updatePop}${write("")}`;

  return withMarker(`import { Router${links === "none" ? "" : ", type Request"} } from "express";
${header}
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

${helpers}${boundsConstant}${
    links === "none"
      ? ""
      : `
// A link names an entry the caller may read: its type's read grant, and its record condition.
const allowed =
  (req: Request): Allowed =>
  (type, row) =>
    authorizeAction(roleOf(req), type, "read") && recordAllowed(req, type, "read", row);

const view = async (req: Request, row: Record<string, unknown>) =>
  filterRead(req, "${typeName}", await readLinks("${typeName}", row, allowed(req)));
`
  }
export const ${t}Router = Router();

${route(
  "get",
  `"/"`,
  "req",
  `${denied("read")}
  const rows = ${listAll};
  const all = rows.filter((row) => recordAllowed(req, "${typeName}", "read", row));
  const sort = sortColumn(req, "${typeName}", req.query._sort);
  const order = String(req.query._order ?? "ASC").toUpperCase() === "DESC" ? -1 : 1;
  all.sort((a, b) => (a[sort as keyof typeof a] > b[sort as keyof typeof b] ? order : -order));
  const start = Number(req.query._start ?? 0);
  const end = Number(req.query._end ?? all.length);
  const page = ${shownAll("all.slice(start, end)")};
  res.setHeader("Content-Range", \`${t} \${start}-\${Math.max(start, end - 1)}/\${all.length}\`);
  res.json(page);`,
)}

${route(
  "get",
  byId,
  "req",
  `${denied("read")}
  const row = await find(Number(req.params.id));${notFound(`!row || !recordAllowed(req, "${typeName}", "read", row)`)}
  res.json(${shown("row")});`,
)}

${route(
  "post",
  `"/"`,
  "req",
  `${denied("create")}
  const proposed = pick(req.body, [${writable}]);${securedCreate}${readBack}
  res.status(201).json(${shown("row")});`,
)}

${route(
  "patch",
  byId,
  "req",
  `${denied("update")}${existing("update")}
  const incoming = keepOwners(req, "${typeName}", pick(req.body, [${writable}]));${securedPatch}${readBack}
  res.json(${shown("row")});`,
)}

${route(
  "delete",
  byId,
  "req",
  `${denied("delete")}${existing("delete")}${remove}
  res.json({ id });`,
)}
`);
};
