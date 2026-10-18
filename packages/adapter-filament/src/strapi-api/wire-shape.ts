import { expandComponents } from "@camis/adapter-kernel";
import type { ContentType, FieldType, IrDocument } from "@camis/ir-schema";
import { childTableEmit } from "../components";
import { filamentNames, snake, snakeColumn } from "../names";
import { camelKey, kebab } from "./names";

export interface WireScalar {
  key: string[];
  column: string;
  type: FieldType;
}
export interface WireChild {
  key: string[];
  relation: string;
  model: string;
  scalars: WireScalar[];
}
/** How a relation is stored, from this side: the Eloquent relation type `relations.ts` declares. */
export type WireRelationKind = "belongsTo" | "hasOne" | "hasMany" | "belongsToMany";
export interface WireRelation {
  key: string;
  /** The Eloquent relation method on this model. */
  relation: string;
  kind: WireRelationKind;
  /** The target's model class name. */
  model: string;
  /** The foreign key column: on this table for belongsTo, on the target's for hasOne/hasMany. */
  foreignKey: string | null;
  /** The target's Strapi uid (`api::genre.genre`), which Strapi's relation errors name. */
  uid: string;
  /** Which side's rows hold the link: this one (its FK or its own pivot) or the target. */
  holder: "self" | "target";
  /** Whether the target keeps a draft and a published version (Phase 21). */
  draftPublish: boolean;
}
export interface WireShape {
  model: string;
  /** The route key's column: `options.upsertBy`'s, else Strapi 5's `document_id`. */
  keyColumn: string;
  /** Whether `PUT /:key` on a missing key creates the row (only when `upsertBy` names the key). */
  upsert: boolean;
  scalars: WireScalar[];
  children: WireChild[];
  /** The top-level component keys, embedded or repeatable, in IR order: what populate can name. */
  components: string[];
  /** Relations to other content types, both the sides this type declares and their inverses. */
  relations: WireRelation[];
  /** Whether this type keeps a draft and a published version of each document. */
  draftPublish: boolean;
}

// `_fkNames` is accepted for signature stability with the controller emitter (Task 5+);
// relations are excluded by construction, so the current shape builder never reads it.
export const wireShape = (
  doc: IrDocument,
  ct: ContentType,
  _fkNames: string[],
  versioned: ReadonlySet<string> = new Set(),
): WireShape => {
  const names = filamentNames(ct);
  const expansion = expandComponents(doc, ct);
  const top: WireScalar[] = ct.fields
    .filter((f) => f.type !== "relation" && f.type !== "component")
    .map((f) => ({ key: [camelKey(f.name)], column: snakeColumn(f.name), type: f.type }));
  const embedded: WireScalar[] = expansion.scalars.map((s) => ({
    key: s.path.map(camelKey),
    column: s.path.map(snakeColumn).join("_"),
    type: s.field.type,
  }));
  const children: WireChild[] = expansion.tables.map((t) => {
    const child = childTableEmit(ct, t);
    return {
      key: t.path.map(camelKey),
      relation: child.relationName,
      model: child.model,
      scalars: t.scalars.map((s) => ({
        key: s.path.map(camelKey),
        column: s.path.map(snakeColumn).join("_"),
        type: s.field.type,
      })),
    };
  });
  const components = ct.fields.filter((f) => f.type === "component").map((f) => camelKey(f.name));
  const upsertBy = ct.options?.upsertBy;
  return {
    model: names.model,
    keyColumn: upsertBy !== undefined ? snakeColumn(upsertBy) : "document_id",
    upsert: upsertBy !== undefined,
    scalars: [...top, ...embedded],
    children,
    components,
    relations: wireRelations(doc, ct, versioned),
    draftPublish: versioned.has(ct.name),
  };
};

const strapiUid = (ct: ContentType): string => `api::${kebab(ct.name)}.${kebab(ct.name)}`;

/**
 * Mirrors `resolveRelations`' method names and foreign keys. A relation to the built-in user is
 * left out: there is no user serializer to expose it through, and the grant that assigns it
 * (`assign: { owner: "user.id" }`) already owns its writes.
 */
const wireRelations = (
  doc: IrDocument,
  ct: ContentType,
  versioned: ReadonlySet<string>,
): WireRelation[] => {
  const byName = new Map(doc.contentTypes.map((c) => [c.name, c]));
  const entry = (
    name: string,
    kind: WireRelationKind,
    target: ContentType,
    foreignKey: string | null,
    holder: WireRelation["holder"],
  ): WireRelation => ({
    key: camelKey(name),
    relation: name,
    kind,
    model: filamentNames(target).model,
    foreignKey,
    uid: strapiUid(target),
    holder,
    draftPublish: versioned.has(target.name),
  });
  const own: WireRelation[] = [];
  for (const f of ct.fields) {
    if (f.type !== "relation") continue;
    const target = byName.get(f.target);
    if (target === undefined || target.builtin !== undefined) continue;
    if (f.relationKind === "manyToOne" || f.relationKind === "oneToOne") {
      own.push(entry(f.name, "belongsTo", target, `${snakeColumn(f.name)}_id`, "self"));
    } else if (f.relationKind === "oneToMany") {
      const fk = `${snakeColumn(f.inverse ?? snake(ct.name))}_id`;
      own.push(entry(f.name, "hasMany", target, fk, "target"));
    } else {
      own.push(entry(f.name, "belongsToMany", target, null, "self"));
    }
  }
  const inverse: WireRelation[] = [];
  if (ct.builtin === undefined) {
    for (const other of doc.contentTypes.filter((c) => c.builtin === undefined)) {
      for (const g of other.fields) {
        if (g.type !== "relation" || g.target !== ct.name || g.inverse === undefined) continue;
        if (g.relationKind === "manyToOne") {
          inverse.push(entry(g.inverse, "hasMany", other, `${snakeColumn(g.name)}_id`, "target"));
        } else if (g.relationKind === "oneToOne") {
          inverse.push(entry(g.inverse, "hasOne", other, `${snakeColumn(g.name)}_id`, "target"));
        } else if (g.relationKind === "oneToMany") {
          inverse.push(
            entry(g.inverse, "belongsTo", other, `${snakeColumn(g.inverse)}_id`, "self"),
          );
        } else {
          inverse.push(entry(g.inverse, "belongsToMany", other, null, "target"));
        }
      }
    }
  }
  return [...own, ...inverse];
};
