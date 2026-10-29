import { expandComponents } from "@camis/adapter-kernel";
import { fieldApiName, type ContentType, type FieldType, type IrDocument } from "@camis/ir-schema";
import { childTableEmit } from "../components";
import { filamentNames, snake, snakeColumn } from "../names";
import { FILE_UID } from "./media-runtime";
import { componentUid, kebab } from "./names";

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
/** One component a dynamic zone holds: its uid on the wire and the child relation its items live in. */
export interface WireZoneMember {
  uid: string;
  /** The component's display name, as the admin labels its items. */
  label: string;
  relation: string;
  model: string;
  scalars: WireScalar[];
  /** Its own component and media keys, which Strapi sends only when the zone's populate names them. */
  components: string[];
}
export interface WireZone {
  key: string;
  members: WireZoneMember[];
}
/** How a relation is stored, from this side: the Eloquent relation type `relations.ts` declares. */
export type WireRelationKind =
  | "belongsTo"
  | "hasOne"
  | "hasMany"
  | "belongsToMany"
  | "localizations"
  | "mediaOne"
  | "mediaMany";
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
  /** Whether the target keeps one row per locale (Phase 22). */
  localized: boolean;
  /** Where a to-many side keeps its targets' link order (Strapi's `*_ord`), when it has one. */
  order: LinkOrder | null;
  /** Where this row's place in the target's own to-many list is kept, when the target lists it. */
  inverseOrder: LinkOrder | null;
}
/** An order column: on the pivot for a many-to-many, else on the table holding the foreign key. */
export interface LinkOrder {
  table: string;
  column: string;
}
export interface WireShape {
  model: string;
  /** The route key's column: `options.upsertBy`'s, else Strapi 5's `document_id`. */
  keyColumn: string;
  /** Whether `PUT /:key` on a missing key creates the row (only when `upsertBy` names the key). */
  upsert: boolean;
  scalars: WireScalar[];
  children: WireChild[];
  /** The top-level component keys, embedded or repeatable, and the zones, in IR order: what populate can name. */
  components: string[];
  zones: WireZone[];
  /** Relations to other content types, both the sides this type declares and their inverses. */
  relations: WireRelation[];
  /** Whether this type keeps a draft and a published version of each document. */
  draftPublish: boolean;
  /** Whether this type keeps one row per locale of each document. */
  localized: boolean;
}

// `_fkNames` is accepted for signature stability with the controller emitter (Task 5+);
// relations are excluded by construction, so the current shape builder never reads it.
// With `fileModel`, the media library's model, media fields are links to its files; without it
// (the Strapi storage layout, which reports them) they stay where they were, among the scalars.
export const wireShape = (
  doc: IrDocument,
  ct: ContentType,
  _fkNames: string[],
  versioned: ReadonlySet<string> = new Set(),
  localized: ReadonlySet<string> = new Set(),
  fileModel?: string,
): WireShape => {
  const names = filamentNames(ct);
  const expansion = expandComponents(doc, ct);
  const top: WireScalar[] = ct.fields
    .filter(
      (f) =>
        f.type !== "relation" &&
        f.type !== "component" &&
        f.type !== "dynamicZone" &&
        (f.type !== "media" || fileModel === undefined),
    )
    .map((f) => ({ key: [fieldApiName(f)], column: snakeColumn(f.name), type: f.type }));
  const embedded: WireScalar[] = expansion.scalars.map((s) => ({
    key: s.apiPath,
    column: s.path.map(snakeColumn).join("_"),
    type: s.field.type,
  }));
  const children: WireChild[] = expansion.tables.map((t) => {
    const child = childTableEmit(ct, t);
    return {
      key: t.apiPath,
      relation: child.relationName,
      model: child.model,
      scalars: t.scalars.map((s) => ({
        key: s.apiPath,
        column: s.path.map(snakeColumn).join("_"),
        type: s.field.type,
      })),
    };
  });
  const components = ct.fields
    .filter((f) => f.type === "component" || f.type === "dynamicZone")
    .map((f) => fieldApiName(f));
  const zones: WireZone[] = expansion.zones.map((z) => ({
    key: z.apiName,
    members: z.members.map((m) => {
      const child = childTableEmit(ct, m.table);
      return {
        uid: componentUid(m.component),
        label: m.component.name,
        relation: child.relationName,
        model: child.model,
        scalars: m.table.scalars.map((s) => ({
          key: s.apiPath,
          column: s.path.map(snakeColumn).join("_"),
          type: s.field.type,
        })),
        components: m.component.fields
          .filter((f) => f.type === "component" || f.type === "media")
          .map((f) => fieldApiName(f)),
      };
    }),
  }));
  const upsertBy = ct.options?.upsertBy;
  return {
    model: names.model,
    keyColumn: upsertBy !== undefined ? snakeColumn(upsertBy) : "document_id",
    upsert: upsertBy !== undefined,
    scalars: [...top, ...embedded],
    children,
    components,
    zones,
    relations: [
      ...wireRelations(doc, ct, versioned, localized),
      ...(fileModel === undefined ? [] : mediaRelations(ct, fileModel)),
      // Strapi's `localizations`: the document's other locales, populated like a relation.
      ...(localized.has(ct.name)
        ? [
            {
              key: "localizations",
              relation: "localizations",
              kind: "localizations" as const,
              model: names.model,
              foreignKey: null,
              uid: strapiUid(ct),
              holder: "self" as const,
              draftPublish: versioned.has(ct.name),
              localized: true,
              order: null,
              inverseOrder: null,
            },
          ]
        : []),
    ],
    draftPublish: versioned.has(ct.name),
    localized: localized.has(ct.name),
  };
};

/** A media field links files through Strapi's `files_related_mph`, in the order given. */
const mediaRelations = (ct: ContentType, fileModel: string): WireRelation[] =>
  ct.fields.flatMap((f) =>
    f.type === "media"
      ? [
          {
            key: fieldApiName(f),
            relation: f.name,
            kind: f.multiple === true ? ("mediaMany" as const) : ("mediaOne" as const),
            model: fileModel,
            foreignKey: null,
            uid: FILE_UID,
            holder: "self" as const,
            draftPublish: false,
            localized: false,
            order: null,
            inverseOrder: null,
          },
        ]
      : [],
  );

/** The users-permissions user's uid, which its relation errors name. */
export const USER_UID = "plugin::users-permissions.user";

const strapiUid = (ct: ContentType): string =>
  ct.builtin === "user" ? USER_UID : `api::${kebab(ct.name)}.${kebab(ct.name)}`;

/**
 * Mirrors `resolveRelations`' method names and foreign keys. A relation to the users-permissions
 * user is one like any other (rendered by `UserSerializer`); the user keeps no inverse side, and
 * other built-in targets are reached through their own fields (media).
 */
const wireRelations = (
  doc: IrDocument,
  ct: ContentType,
  versioned: ReadonlySet<string>,
  localized: ReadonlySet<string>,
): WireRelation[] => {
  const byName = new Map(doc.contentTypes.map((c) => [c.name, c]));
  const entry = (
    key: string,
    name: string,
    kind: WireRelationKind,
    target: ContentType,
    foreignKey: string | null,
    holder: WireRelation["holder"],
    order: Pick<WireRelation, "order" | "inverseOrder"> = { order: null, inverseOrder: null },
  ): WireRelation => ({
    key,
    relation: name,
    kind,
    model: filamentNames(target).model,
    foreignKey,
    uid: strapiUid(target),
    holder,
    draftPublish: versioned.has(target.name),
    localized: localized.has(target.name),
    ...order,
  });
  const table = (c: ContentType): string => filamentNames(c).table;
  // A many-to-many keeps both sides' orders on its pivot, as Strapi's link table does: the
  // column named for a side holds that side's place in the other's list.
  const pivotOrder = (
    self: ContentType,
    target: ContentType,
  ): Pick<WireRelation, "order" | "inverseOrder"> => {
    const [a, b] = [snake(self.name), snake(target.name)];
    if (a === b) return { order: null, inverseOrder: null };
    const pivot = a < b ? `${a}_${b}` : `${b}_${a}`;
    return {
      order: { table: pivot, column: `${b}_ord` },
      inverseOrder: { table: pivot, column: `${a}_ord` },
    };
  };
  const own: WireRelation[] = [];
  for (const f of ct.fields) {
    if (f.type !== "relation") continue;
    const target = byName.get(f.target);
    if (target === undefined || (target.builtin !== undefined && target.builtin !== "user"))
      continue;
    if (f.relationKind === "manyToOne" || f.relationKind === "oneToOne") {
      const base = snakeColumn(f.name);
      // The target lists this row only through a declared inverse of a many-to-one.
      const listed = f.relationKind === "manyToOne" && f.inverse !== undefined;
      own.push(
        entry(fieldApiName(f), f.name, "belongsTo", target, `${base}_id`, "self", {
          order: null,
          inverseOrder: listed ? { table: table(ct), column: `${base}_ord` } : null,
        }),
      );
    } else if (f.relationKind === "oneToMany") {
      const base = snakeColumn(f.inverse ?? snake(ct.name));
      own.push(
        entry(fieldApiName(f), f.name, "hasMany", target, `${base}_id`, "target", {
          order: { table: table(target), column: `${base}_ord` },
          inverseOrder: null,
        }),
      );
    } else {
      own.push(
        entry(
          fieldApiName(f),
          f.name,
          "belongsToMany",
          target,
          null,
          "self",
          pivotOrder(ct, target),
        ),
      );
    }
  }
  const inverse: WireRelation[] = [];
  if (ct.builtin === undefined) {
    for (const other of doc.contentTypes.filter((c) => c.builtin === undefined)) {
      for (const g of other.fields) {
        if (g.type !== "relation" || g.target !== ct.name || g.inverse === undefined) continue;
        if (g.relationKind === "manyToOne") {
          const base = snakeColumn(g.name);
          inverse.push(
            entry(g.inverse, g.inverse, "hasMany", other, `${base}_id`, "target", {
              order: { table: table(other), column: `${base}_ord` },
              inverseOrder: null,
            }),
          );
        } else if (g.relationKind === "oneToOne") {
          inverse.push(
            entry(g.inverse, g.inverse, "hasOne", other, `${snakeColumn(g.name)}_id`, "target"),
          );
        } else if (g.relationKind === "oneToMany") {
          const base = snakeColumn(g.inverse);
          inverse.push(
            entry(g.inverse, g.inverse, "belongsTo", other, `${base}_id`, "self", {
              order: null,
              inverseOrder: { table: table(ct), column: `${base}_ord` },
            }),
          );
        } else {
          inverse.push(
            entry(
              g.inverse,
              g.inverse,
              "belongsToMany",
              other,
              null,
              "target",
              pivotOrder(ct, other),
            ),
          );
        }
      }
    }
  }
  return [...own, ...inverse];
};
