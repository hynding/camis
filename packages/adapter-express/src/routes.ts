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
  const secured = options.secured === true;
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
  // A row and its to-many links are written together or not at all, and a secured update or delete
  // checks the row it writes inside the same transaction (see `src/db/atomic.ts`).
  const atomicImport =
    secured || own ? `\nimport { atomic, type Executor } from "../db/atomic";` : "";
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
  const refused = await checkLinks(db, "${typeName}", ${body}, ${allowed});
  if (refused !== null) {
    res.status(400).json({ error: refused });
    return;
  }`;
  // A write must leave a row the role's condition for it holds on: a create may not make, and an
  // update may not turn its row into, one the role could not have written.
  const createRefusal = `
  if (!recordAllowed(req, "${typeName}", "create", data)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }`;
  const shown = (row: string) =>
    links === "none" ? `filterRead(req, "${typeName}", ${row})` : `await view(req, ${row})`;
  const shownAll = (rows: string) =>
    links === "none"
      ? `${rows}.map((row) => filterRead(req, "${typeName}", row))`
      : `await Promise.all(${rows}.map((row) => view(req, row)))`;
  const readLinked = (row: string) =>
    links === "none" ? row : `await readLinks(db, "${typeName}", ${row}, allowed)`;

  // Every database's client awaits a query; only an insert's id is dialect's own: MySQL has no
  // RETURNING, so drizzle answers the id from the insert's result there. No write returns its row on
  // MySQL, so each write reads it back on every database, which keeps the answers the same.
  const insertedId = (executor: string) =>
    `const [{ id }] = await ${executor}.insert(${t}).values(data)${
      options.dialect === "mysql" ? ".$returningId()" : `.returning({ id: ${t}.id })`
    };`;
  const update = (executor: string, data: string, indent: string) =>
    `if (Object.keys(${data}).length > 0)\n${indent}  await ${executor}.update(${t}).set(${data}).where(eq(${t}.id, id));`;
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
  // On PostgreSQL and MySQL the row is locked until the transaction ends, so no other write changes
  // it between the checks and the write; SQLite's BEGIN IMMEDIATE holds the whole database already.
  const lock =
    options.dialect === undefined || options.dialect === "sqlite" ? "" : `.for("update")`;
  const lockRow = `
/** The row, read inside a transaction, so that the checks on it and the write see the same row. */
const lockRow = async (tx: Executor, id: number) =>
  (await tx.select().from(${t}).where(eq(${t}.id, id)).limit(1)${lock})[0];
`;
  // Without links an update or a delete is one statement, which a concurrent delete leaves with no
  // row to write: the read back answers 404. With to-many links the row is read locked inside the
  // transaction that writes its links, so concurrent writes of one row take turns (each replacing
  // the links the one before it left) and a write after a delete finds no row.
  const write = (body: string) =>
    own
      ? `
  const written = await atomic(async (tx) => {
    const existing = await lockRow(tx, id);
    if (!existing) return false;
    ${update("tx", "data", "    ")}
    await writeLinks(tx, "${typeName}", id, ${body});
    return true;
  });${notFound("!written")}`
      : `
  ${update("db", "data", "  ")}`;
  const remove = own
    ? `
  await atomic(async (tx) => {
    if (!(await lockRow(tx, id))) return;
    await dropLinks(tx, "${typeName}", id);
    await tx.delete(${t}).where(eq(${t}.id, id));
  });`
    : `
  await db.delete(${t}).where(eq(${t}.id, id));`;
  const readBack = `
  const row = await find(id);${notFound("!row")}`;
  // The write succeeded, so a row that is not there to read back is the server's failure, not a 404.
  const createdReadBack = `
  const row = await find(id);
  if (!row) throw new Error(\`${t} \${id} was written but could not be read back\`);`;

  const header = `import { asc, eq } from "drizzle-orm";
import { asyncRoute } from "../async-route";
import { db } from "../db/client";${atomicImport}
import { ${t} } from "../db/schema";
import { routeId } from "../ids";`;
  const helpers = `function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

const find = async (id: number) =>
  (await db.select().from(${t}).where(eq(${t}.id, id)).limit(1))[0];
`;
  const listAll = `await db.select().from(${t}).orderBy(asc(${t}.id))`;
  const route = (method: string, path: string, req: string, body: string) =>
    `${t}Router.${method}(${path}, asyncRoute(async (${req}, res) => {${body}
}));`;
  // An id past what an integer column holds is a 404 before any query (`src/ids.ts`).
  const routerDeclaration = `export const ${t}Router = Router();
${t}Router.param("id", routeId);`;

  if (!secured) {
    const list =
      links === "none"
        ? `
  res.json(${listAll});`
        : `
  const rows = ${listAll};
  res.json(await Promise.all(rows.map((row) => readLinks(db, "${typeName}", row, allowed))));`;
    const create = own
      ? `
  const body = pick(req.body, [${writable}]);${refusal("body", "allowed")}
  ${dataDecl} data = linkColumns("${typeName}", body);${createPop}${insert("body")}`
      : `
  ${dataDecl} data = pick(req.body, [${cols}]);${createPop}${insert("")}`;
    // The find answers a missing row before its links are checked or anything is generated; the
    // locked read inside the transaction decides.
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

${helpers}${own ? lockRow : ""}${boundsConstant}${links === "none" ? "" : `\n// Without grants every caller reads every entry a link names.\nconst allowed: Allowed = () => true;\n`}
${routerDeclaration}

${route("get", `"/"`, "_req", list)}

${route(
  "get",
  `"/:id"`,
  "req",
  `
  const row = await find(Number(req.params.id));${notFound("!row")}
  res.json(${readLinked("row")});`,
)}

${route(
  "post",
  `"/"`,
  "req",
  `${lengthCheck}${create}${createdReadBack}
  res.status(201).json(${readLinked("row")});`,
)}

${route(
  "patch",
  `"/:id"`,
  "req",
  `${lengthCheck}${patch}${readBack}
  res.json(${readLinked("row")});`,
)}

${route(
  "delete",
  `"/:id"`,
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
  const securedCreate = own
    ? `
  const permitted = assignOwners(req, "${typeName}", stripWrites(req, "${typeName}", proposed, proposed));${refusal("permitted", "allowed(req)")}
  ${dataDecl} data = linkColumns("${typeName}", permitted);${createRefusal}${permittedLengthCheck}${createPop}${insert("permitted")}`
    : `
  ${dataDecl} data = assignOwners(req, "${typeName}", stripWrites(req, "${typeName}", proposed, proposed));${createRefusal}${permittedLengthCheck}${createPop}${insert("")}`;

  const refusalOf = (condition: string, status: number, error: string) =>
    `  if (${condition}) return { status: ${status}, error: ${error} };`;
  const permittedUpdate = `
type Refusal = { status: number; error: string };
type Row = Record<string, unknown>;

/**
 * What an update may write to this row, or why it may not: its record condition and field rules.
 * Inside a transaction its queries go through the transaction's executor.
 */
const permittedUpdate = async (
  executor: Executor,
  req: Request,
  existing: Row,
  incoming: Row,
): Promise<Refusal | { data: Row; permitted: Row }> => {
${refusalOf(`!recordAllowed(req, "${typeName}", "update", existing)`, 404, `"not found"`)}
  const permitted = stripWrites(req, "${typeName}", { ...existing, ...incoming }, incoming);${
    own
      ? `
  const refused = await checkLinks(executor, "${typeName}", permitted, allowed(req));
  if (refused !== null) return { status: 400, error: refused };`
      : ""
  }
  const data = ${own ? `linkColumns("${typeName}", permitted)` : "permitted"};
${refusalOf(`!recordAllowed(req, "${typeName}", "update", { ...existing, ...data })`, 403, `"forbidden"`)}${
    bounds.length === 0
      ? ""
      : `
  const longer = tooLong(data, MAX_LENGTHS);
  if (longer !== null) return { status: 400, error: longer };`
  }
  return { data, permitted };
};
`;
  const writeLinksOf = own
    ? `
    await writeLinks(tx, "${typeName}", id, write.permitted);`
    : "";
  const answerRefusal = `
  if ("error" in outcome) {
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }`;
  // The AI fields are generated before the transaction, which would otherwise hold its row (and on
  // SQLite every other write) while it waits on the provider; they are written only if the row,
  // read again inside it, permits the same write.
  const securedPatch = hasAi
    ? `
  const existing = await find(id);${notFound("!existing")}
  const before = await permittedUpdate(db, req, existing, incoming);
  if ("error" in before) {
    res.status(before.status).json({ error: before.error });
    return;
  }
  const generated = await populateAiFields("${typeName}", { ...before.data }, "update");
  const outcome = await atomic(async (tx) => {
    const locked = await lockRow(tx, id);
    if (!locked) return { status: 404, error: "not found" };
    const write = await permittedUpdate(tx, req, locked, incoming);
    if ("error" in write) return write;
    if (JSON.stringify(write.data) !== JSON.stringify(before.data))
      return { status: 409, error: "the entry changed while it was being updated; send the update again" };
    ${update("tx", "generated", "    ")}${writeLinksOf}
    return write;
  });${answerRefusal}`
    : `
  const outcome = await atomic(async (tx) => {
    const existing = await lockRow(tx, id);
    if (!existing) return { status: 404, error: "not found" };
    const write = await permittedUpdate(tx, req, existing, incoming);
    if ("error" in write) return write;
    ${update("tx", "write.data", "    ")}${writeLinksOf}
    return write;
  });${answerRefusal}`;

  return withMarker(`import { Router, type Request } from "express";
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

${helpers}${lockRow}${boundsConstant}${
    links === "none"
      ? ""
      : `
// A link names an entry the caller may read: its type's read grant, and its record condition.
const allowed =
  (req: Request): Allowed =>
  (type, row) =>
    authorizeAction(roleOf(req), type, "read") && recordAllowed(req, type, "read", row);

const view = async (req: Request, row: Record<string, unknown>) =>
  filterRead(req, "${typeName}", await readLinks(db, "${typeName}", row, allowed(req)));
`
  }${permittedUpdate}
${routerDeclaration}

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
  `"/:id"`,
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
  const proposed = pick(req.body, [${writable}]);${securedCreate}${createdReadBack}
  res.status(201).json(${shown("row")});`,
)}

${route(
  "patch",
  `"/:id"`,
  "req",
  `${denied("update")}
  const id = Number(req.params.id);
  const incoming = keepOwners(req, "${typeName}", pick(req.body, [${writable}]));${securedPatch}${readBack}
  res.json(${shown("row")});`,
)}

${route(
  "delete",
  `"/:id"`,
  "req",
  `${denied("delete")}
  const id = Number(req.params.id);
  const deleted = await atomic(async (tx) => {
    const existing = await lockRow(tx, id);
    if (!existing || !recordAllowed(req, "${typeName}", "delete", existing)) return false;${
      own
        ? `
    await dropLinks(tx, "${typeName}", id);`
        : ""
    }
    await tx.delete(${t}).where(eq(${t}.id, id));
    return true;
  });${notFound("!deleted")}
  res.json({ id });`,
)}
`);
};
