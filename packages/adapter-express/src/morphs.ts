import { withMarker } from "@camis/adapter-kernel";
import type { ContentType, Field, IrDocument } from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { expressNames, snakeColumn } from "./names";

type PolymorphicRelation = Extract<Field, { type: "polymorphicRelation" }>;
type PolymorphicInverse = Extract<Field, { type: "polymorphicInverse" }>;

/** A polymorphic link a content type holds: a to-one's two columns, or a to-many's link table. */
export interface OwnLink {
  /** The key a body and a row carry it under, as every other column of the Express target. */
  key: string;
  many: boolean;
  /** The to-many's link table: `<owner table>_<key>`. */
  table: string;
  /** The link table's column naming its owner entry. */
  ownerColumn: string;
}

/** A polymorphic inverse: the entries of `owner` whose link `via` names this entry. */
export interface InverseLink {
  key: string;
  many: boolean;
  owner: ContentType;
  via: OwnLink;
}

export interface MorphLinks {
  own: Map<string, OwnLink[]>;
  inverses: Map<string, InverseLink[]>;
}

const ownLink = (ct: ContentType, f: PolymorphicRelation): OwnLink => {
  const key = snakeColumn(f.name);
  return {
    key,
    many: f.many,
    table: `${expressNames(ct).table}_${key}`,
    ownerColumn: `${snakeColumn(ct.name)}_id`,
  };
};

/** Each content type's polymorphic links and inverses (the IR guarantees an inverse's `via`). */
export const morphLinks = (doc: IrDocument): MorphLinks => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const own = new Map<string, OwnLink[]>();
  const inverses = new Map<string, InverseLink[]>();
  for (const ct of doc.contentTypes) {
    const links = ct.fields
      .filter((f): f is PolymorphicRelation => f.type === "polymorphicRelation")
      .map((f) => ownLink(ct, f));
    if (links.length > 0) own.set(ct.name, links);
  }
  for (const ct of doc.contentTypes) {
    const read = ct.fields
      .filter((f): f is PolymorphicInverse => f.type === "polymorphicInverse")
      .flatMap((f): InverseLink[] => {
        const owner = byName.get(f.target);
        const via = own.get(f.target)?.find((l) => l.key === snakeColumn(f.via));
        return owner === undefined || via === undefined
          ? []
          : [{ key: snakeColumn(f.name), many: f.many, owner, via }];
      });
    if (read.length > 0) inverses.set(ct.name, read);
  }
  return { own, inverses };
};

const typeColumn = (dialect: Dialect, name: string): { expr: string; import: string } =>
  dialect === "sqlite"
    ? { expr: `text('${name}')`, import: "text" }
    : { expr: `varchar('${name}', { length: 255 })`, import: "varchar" };
const idColumn = (dialect: Dialect, name: string): { expr: string; import: string } =>
  dialect === "mysql"
    ? { expr: `int('${name}')`, import: "int" }
    : { expr: `integer('${name}')`, import: "integer" };

/** A to-one link's columns on its owner's row: the entry's id and its content type's name. */
export const linkColumns = (
  dialect: Dialect,
  links: readonly OwnLink[],
): { line: string; import: string }[] =>
  links
    .filter((l) => !l.many)
    .flatMap((l) => {
      const id = idColumn(dialect, `${l.key}_id`);
      const type = typeColumn(dialect, `${l.key}_type`);
      return [
        { line: `  ${l.key}_id: ${id.expr},`, import: id.import },
        { line: `  ${l.key}_type: ${type.expr},`, import: type.import },
      ];
    });

/** A to-many link's table: a row per link, in order, naming its owner and the entry it links. */
export const linkTable = (
  dialect: Dialect,
  link: OwnLink,
  ownerTable: string,
  tableFn: string,
  idColumnExpr: string,
): { block: string; imports: string[] } => {
  const owner = idColumn(dialect, link.ownerColumn);
  const target = idColumn(dialect, "target_id");
  const type = typeColumn(dialect, "target_type");
  const position = idColumn(dialect, "position");
  return {
    block: `export const ${link.table} = ${tableFn}("${link.table}", {
  ${idColumnExpr},
  ${link.ownerColumn}: ${owner.expr}.notNull().references(() => ${ownerTable}.id),
  target_id: ${target.expr}.notNull(),
  target_type: ${type.expr}.notNull(),
  position: ${position.expr}.notNull(),
});`,
    imports: [owner.import, type.import],
  };
};

const table = (ct: ContentType): string => expressNames(ct).table;

/**
 * `src/morphs.ts`: reading, checking and writing a project's polymorphic links. A link is
 * `{ type, id }`, `type` being a content type's name; one the caller may not read (no read grant,
 * or a record condition hides it) is refused on write and left out on read, as is one whose entry
 * is gone.
 */
export const emitMorphsFile = (doc: IrDocument, links: MorphLinks): string => {
  const types = [...doc.contentTypes].sort((a, b) => a.name.localeCompare(b.name));
  const linkTables = [...links.own.values()].flat().filter((l) => l.many);
  const imports = [...new Set([...types.map(table), ...linkTables.map((l) => l.table)])].sort();
  const find = types
    .map(
      (ct) =>
        `  ${ct.name}: async (id) =>\n    (await db.select().from(${table(ct)}).where(eq(${table(ct)}.id, id)).limit(1))[0],`,
    )
    .join("\n");
  const own = [...links.own]
    .map(
      ([type, list]) =>
        `  ${type}: [${list.map((l) => `{ key: "${l.key}", many: ${l.many} }`).join(", ")}],`,
    )
    .join("\n");
  const tables = [...links.own]
    .flatMap(([type, list]) =>
      list
        .filter((l) => l.many)
        .map(
          (l) => `  "${type}.${l.key}": {
    read: (owner) =>
      db
        .select({ type: ${l.table}.target_type, id: ${l.table}.target_id })
        .from(${l.table})
        .where(eq(${l.table}.${l.ownerColumn}, owner))
        .orderBy(asc(${l.table}.position)),
    replace: async (tx, owner, entries) => {
      await tx.delete(${l.table}).where(eq(${l.table}.${l.ownerColumn}, owner));
      if (entries.length > 0)
        await tx
          .insert(${l.table})
          .values(entries.map((e, position) => ({ ${l.ownerColumn}: owner, target_type: e.type, target_id: e.id, position })));
    },
  },`,
        ),
    )
    .join("\n");
  const inverses = [...links.inverses]
    .map(([type, list]) => {
      const reads = list.map((inverse) => {
        const owner = table(inverse.owner);
        const read = inverse.via.many
          ? `async (id) =>
        (
          await db
            .select({ row: ${owner} })
            .from(${inverse.via.table})
            .innerJoin(${owner}, eq(${inverse.via.table}.${inverse.via.ownerColumn}, ${owner}.id))
            .where(and(eq(${inverse.via.table}.target_type, "${type}"), eq(${inverse.via.table}.target_id, id)))
            .orderBy(asc(${owner}.id))
        ).map((r) => r.row)`
          : `(id) =>
        db
          .select()
          .from(${owner})
          .where(and(eq(${owner}.${inverse.via.key}_type, "${type}"), eq(${owner}.${inverse.via.key}_id, id)))
          .orderBy(asc(${owner}.id))`;
        return `    {
      key: "${inverse.key}",
      many: ${inverse.many},
      owner: "${inverse.owner.name}",
      read: ${read},
    },`;
      });
      return `  ${type}: [\n${reads.join("\n")}\n  ],`;
    })
    .join("\n");

  return withMarker(`import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "./db/atomic";
import { db } from "./db/client";
import { ${imports.join(", ")} } from "./db/schema";

/** An entry a polymorphic link names: its content type and its id. */
export interface Link {
  type: string;
  id: number;
}
type Row = Record<string, unknown>;
/** Whether the caller may read this entry of this content type. */
export type Allowed = (type: string, row: Row) => boolean;

/** Each content type a link may name → its entry with that id, if there is one. */
const FIND: Record<string, (id: number) => Promise<Row | undefined>> = {
${find}
};

/** Each content type's own links, by the key a body and a row carry them under. */
const OWN: Record<string, { key: string; many: boolean }[]> = {
${own}
};

/** Each to-many link's table: an entry's links in order, and replacing them within a transaction. */
const LINK_TABLES: Record<
  string,
  {
    read: (owner: number) => Promise<Link[]>;
    replace: (tx: Executor, owner: number, entries: Link[]) => Promise<void>;
  }
> = {
${tables}
};

/** Each content type's inverses: the entries of another type whose link names an entry of it. */
const INVERSES: Record<
  string,
  { key: string; many: boolean; owner: string; read: (id: number) => Promise<Row[]> }[]
> = {
${inverses}
};

const isLink = (value: unknown): value is Link =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<Link>).type === "string" &&
  Number.isInteger((value as Partial<Link>).id);

/** Whether a link names an entry that is there and that the caller may read. */
const reachable = async (link: Link, allowed: Allowed): Promise<boolean> => {
  const row = await FIND[link.type]?.(link.id);
  return row !== undefined && allowed(link.type, row);
};

/** The links, in order, that name an entry that is there and that the caller may read. */
const reachableOnly = async (entries: Link[], allowed: Allowed): Promise<Link[]> => {
  const out: Link[] = [];
  for (const entry of entries) if (await reachable(entry, allowed)) out.push(entry);
  return out;
};

const unique = (entries: Link[]): Link[] =>
  entries.filter((e, i) => entries.findIndex((o) => o.type === e.type && o.id === e.id) === i);

/** Why a body's links are refused, naming the key; null when every link names a readable entry. */
export const checkLinks = async (type: string, body: Row, allowed: Allowed): Promise<string | null> => {
  for (const { key, many } of OWN[type] ?? []) {
    if (!(key in body)) continue;
    const value = body[key];
    const entries = many ? value : value === null ? [] : [value];
    if (!Array.isArray(entries) || !entries.every(isLink))
      return \`"\${key}" takes \${many ? "a list of " : ""}{ type, id }\`;
    for (const entry of entries)
      if (!(await reachable(entry, allowed)))
        return \`"\${key}" names no \${entry.type} \${entry.id} that can be read\`;
  }
  return null;
};

/** A checked body as its row's columns: a to-one link as its id and type, a to-many's left out. */
export const linkColumns = (type: string, body: Row): Row => {
  const out = { ...body };
  for (const { key, many } of OWN[type] ?? []) {
    if (!(key in out)) continue;
    const link = out[key] as Link | null;
    delete out[key];
    if (!many) Object.assign(out, { [\`\${key}_id\`]: link?.id ?? null, [\`\${key}_type\`]: link?.type ?? null });
  }
  return out;
};

/** Replaces an entry's to-many links with a checked body's, where the body names them. */
export const writeLinks = async (tx: Executor, type: string, id: number, body: Row): Promise<void> => {
  for (const { key, many } of OWN[type] ?? []) {
    if (many && Array.isArray(body[key]))
      await LINK_TABLES[\`\${type}.\${key}\`]?.replace(tx, id, unique(body[key] as Link[]));
  }
};

/** Removes an entry's to-many links, before the entry itself goes. */
export const dropLinks = async (tx: Executor, type: string, id: number): Promise<void> => {
  for (const { key, many } of OWN[type] ?? []) {
    if (many) await LINK_TABLES[\`\${type}.\${key}\`]?.replace(tx, id, []);
  }
};

/** A row with its links as { type, id } and its inverses as the ids of the entries linking it. */
export const readLinks = async (type: string, row: Row, allowed: Allowed): Promise<Row> => {
  const out = { ...row };
  const id = Number(row.id);
  for (const { key, many } of OWN[type] ?? []) {
    if (many) {
      out[key] = await reachableOnly((await LINK_TABLES[\`\${type}.\${key}\`]?.read(id)) ?? [], allowed);
      continue;
    }
    const link = { type: row[\`\${key}_type\`], id: row[\`\${key}_id\`] };
    delete out[\`\${key}_type\`];
    delete out[\`\${key}_id\`];
    out[key] = isLink(link) && (await reachable(link, allowed)) ? link : null;
  }
  for (const inverse of INVERSES[type] ?? []) {
    const ids = (await inverse.read(id)).filter((r) => allowed(inverse.owner, r)).map((r) => r.id);
    out[inverse.key] = inverse.many ? ids : (ids[0] ?? null);
  }
  return out;
};
`);
};
