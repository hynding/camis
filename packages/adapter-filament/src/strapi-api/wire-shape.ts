import { expandComponents, type ExpandedTable } from "@camis/adapter-kernel";
import {
  fieldApiName,
  inverseApiName,
  type Component,
  type ContentType,
  type Field,
  type FieldType,
  type IrDocument,
} from "@camis/ir-schema";
import { camelPath, childTableEmit, type ChildMedia, type ChildTableEmit } from "../components";
import { componentRelations, type ComponentRelation } from "../component-relations";
import { filamentNames, snake, snakeColumn } from "../names";
import { FILE_UID } from "./media-runtime";
import { componentUid, kebab } from "./names";

export interface WireScalar {
  key: string[];
  column: string;
  type: FieldType;
  /** Written, but never answered, filtered, sorted or selected (Strapi's `private`). */
  private?: true;
}
export interface WireChild {
  key: string[];
  /** Its component's Strapi uid, which an archive's links to an item go by. */
  uid: string;
  relation: string;
  model: string;
  scalars: WireScalar[];
  /** Its items' media fields, each a link from the item's row; its key is relative to the item. */
  media: WireEmbeddedMedia[];
  /** Relations inside its items, each held by the item's row; its key is relative to the item. */
  relations: WireComponentRelation[];
  /** Repeatables inside its items, each a table of their own; keyed relative to the item. */
  children: WireChild[];
  private?: true;
}
/**
 * A relation inside a component, held by the row the component lives on (the entry's, or an
 * item's) and keyed by its dotted path from that row (`cta.author`, `link.author`, `author`).
 */
export interface WireComponentRelation extends WireRelation {
  /** The Strapi uid of the component declaring it, which an archive's links from it go by. */
  component: string;
  /** Its name in that component, the archive's link field. */
  field: string;
  /** How that component declares it (`oneToOne`, `oneToMany`, …), as an archive's link says. */
  declares: string;
}
/** A file field of an embedded component, linked from the entry's row. */
export interface WireEmbeddedMedia extends WireRelation {
  /** The Strapi uid of the component holding it, which an archive's link to it goes by. */
  component: string;
  /** Its path in the link rows' `field` (`seo.metaImage`, `icon.image` in an item). */
  field: string;
}
/** One component a dynamic zone holds: its uid on the wire and the child relation its items live in. */
export interface WireZoneMember {
  uid: string;
  /** The component's display name, as the admin labels its items. */
  label: string;
  relation: string;
  model: string;
  scalars: WireScalar[];
  /** Its items' media fields, each a link from the item's row. */
  media: WireEmbeddedMedia[];
  /** Relations inside its items, each held by the item's row. */
  relations: WireComponentRelation[];
  /** Repeatables inside its items. */
  children: WireChild[];
  /** Its own component, media and relation keys, which Strapi sends only when the zone's populate names them. */
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
  private?: true;
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
  /**
   * Media fields of embedded components: links from the entry's own row, keyed by their dotted
   * path on the wire (`seo.metaImage`), since the component is columns of that row.
   */
  embeddedMedia: WireEmbeddedMedia[];
  /** Relations inside embedded components, held by the entry's own row, keyed by their dotted path. */
  embeddedRelations: WireComponentRelation[];
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
  deep = true,
): WireShape => {
  const names = filamentNames(ct);
  // Relations and nested repeatables inside components are stored on Laravel's layout only
  // (`fileModel` names that layout's media library; the Strapi layout passes `deep: false`).
  const expansion = expandComponents(
    doc,
    ct,
    deep ? { componentRelations: true, nestedTables: true } : {},
  );
  const context = deep ? { doc } : undefined;
  const asWireRelation = (r: ComponentRelation): WireComponentRelation =>
    componentWireRelation(r, versioned, localized);
  // A private component keeps every field inside it private too: Strapi never reaches into it.
  const privateKeys = new Set(ct.fields.filter((f) => f.private === true).map(fieldApiName));
  const privacy = (isPrivate: boolean): { private?: true } => (isPrivate ? { private: true } : {});
  const within = (apiPath: string[]): boolean => privateKeys.has(apiPath[0] ?? "");
  const top: WireScalar[] = ct.fields
    .filter(
      (f) =>
        f.type !== "relation" &&
        f.type !== "component" &&
        f.type !== "dynamicZone" &&
        (f.type !== "media" || fileModel === undefined),
    )
    .map((f) => ({
      key: [fieldApiName(f)],
      column: snakeColumn(f.name),
      type: f.type,
      ...privacy(f.private === true),
    }));
  const linked = (s: { field: { type: string } }): boolean =>
    fileModel !== undefined && s.field.type === "media";
  const embedded: WireScalar[] = expansion.scalars
    .filter((s) => !linked(s))
    .map((s) => ({
      key: s.apiPath,
      column: s.path.map(snakeColumn).join("_"),
      type: s.field.type,
      ...privacy(s.field.private === true || within(s.apiPath)),
    }));
  const embeddedMedia: WireEmbeddedMedia[] =
    fileModel === undefined
      ? []
      : expansion.scalars.filter(linked).map((s) => ({
          ...mediaRelation(
            s.apiPath.join("."),
            camelPath(s.path),
            s.field.type === "media" && s.field.multiple === true,
            fileModel,
          ),
          component: componentUid(tableComponent(doc, ct, s.path.slice(0, -1))),
          field: s.path.join("."),
          ...privacy(s.field.private === true || within(s.apiPath)),
        }));
  // An item's file, linked from the item's row: Strapi links it from the component holding it.
  const itemMedia = (m: ChildMedia, item: Component, model: string): WireEmbeddedMedia => ({
    ...mediaRelation(m.apiPath.join("."), m.method, m.multiple, model),
    component: componentUid(componentAlong(doc, item.fields, m.path.slice(0, -1)) ?? item),
    field: m.path.join("."),
  });
  const wireChild = (t: ExpandedTable, child: ChildTableEmit, isPrivate: boolean): WireChild => ({
    key: t.apiPath,
    uid: componentUid(t.component),
    relation: child.relationName,
    model: child.model,
    media:
      fileModel === undefined ? [] : child.media.map((m) => itemMedia(m, t.component, fileModel)),
    relations: child.relations.map((r) => asWireRelation(r)),
    children: t.tables.map((nested, i) => wireChild(nested, child.children[i]!, false)),
    scalars: t.scalars
      .filter((s) => fileModel === undefined || s.field.type !== "media")
      .map((s) => ({
        key: s.apiPath,
        column: s.path.map(snakeColumn).join("_"),
        type: s.field.type,
        ...privacy(s.field.private === true),
      })),
    ...privacy(isPrivate),
  });
  const children: WireChild[] = expansion.tables.map((t) =>
    wireChild(t, childTableEmit(ct, t, fileModel !== undefined, context), within(t.apiPath)),
  );
  const embeddedRelations = componentRelations(
    doc,
    names.table,
    `${snake(ct.name)}_id`,
    expansion.relations,
  ).map((r) => ({
    ...asWireRelation(r),
    ...privacy(within(r.apiPath)),
  }));
  // What populate can name: a private component is not among them, so naming it is refused.
  const components = ct.fields
    .filter((f) => (f.type === "component" || f.type === "dynamicZone") && f.private !== true)
    .map((f) => fieldApiName(f));
  const zones: WireZone[] = expansion.zones.map((z) => ({
    key: z.apiName,
    members: z.members.map((m) => {
      const child = childTableEmit(ct, m.table, fileModel !== undefined, context);
      return {
        uid: componentUid(m.component),
        label: m.component.name,
        relation: child.relationName,
        model: child.model,
        media:
          fileModel === undefined
            ? []
            : child.media.map((f) => itemMedia(f, m.component, fileModel)),
        relations: child.relations.map((r) => asWireRelation(r)),
        children: m.table.tables.map((nested, i) => wireChild(nested, child.children[i]!, false)),
        scalars: m.table.scalars
          .filter((s) => fileModel === undefined || s.field.type !== "media")
          .map((s) => ({
            key: s.apiPath,
            column: s.path.map(snakeColumn).join("_"),
            type: s.field.type,
            ...privacy(s.field.private === true),
          })),
        components: m.component.fields
          .filter(
            (f) => f.type === "component" || f.type === "media" || (deep && f.type === "relation"),
          )
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
    embeddedMedia,
    embeddedRelations,
    components,
    zones,
    relations: [
      ...[
        ...wireRelations(doc, ct, versioned, localized),
        ...(fileModel === undefined ? [] : mediaRelations(ct, fileModel)),
      ].map((r) => ({ ...r, ...privacy(privateKeys.has(r.key)) })),
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

/**
 * A relation inside a component as the API reaches it: like a relation the type declares, from
 * the holding row's own key or link table, and with no inverse (Strapi's go one way).
 */
const componentWireRelation = (
  r: ComponentRelation,
  versioned: ReadonlySet<string>,
  localized: ReadonlySet<string>,
): WireComponentRelation => ({
  key: r.apiPath.join("."),
  relation: r.method,
  kind: r.many ? "belongsToMany" : "belongsTo",
  model: filamentNames(r.target).model,
  foreignKey: r.foreignKey?.column ?? null,
  uid: strapiUid(r.target),
  holder: "self",
  draftPublish: versioned.has(r.target.name),
  localized: localized.has(r.target.name),
  order: r.pivot === null ? null : { table: r.pivot.table, column: r.pivot.order },
  inverseOrder: null,
  component: componentUid(r.component),
  field: r.path[r.path.length - 1]!,
  declares: r.relationKind,
});

/** The component at a path of component fields (a repeatable child table's, or an embedded one's). */
const tableComponent = (doc: IrDocument, ct: ContentType, path: string[]): Component => {
  const found = componentAlong(doc, ct.fields, path);
  if (found === undefined) throw new Error(`${ct.name}.${path.join(".")}: no component there`);
  return found;
};

/** The component a path of component fields leads to from $fields; undefined for an empty path. */
const componentAlong = (
  doc: IrDocument,
  fields: readonly Field[],
  path: readonly string[],
): Component | undefined => {
  let found: Component | undefined;
  for (const name of path) {
    const field = (found?.fields ?? fields).find((f) => f.name === name);
    found =
      field?.type === "component"
        ? doc.components.find((c) => c.name === field.component)
        : undefined;
    if (found === undefined) throw new Error(`${path.join(".")}: no component there`);
  }
  return found;
};

/** A media field links files through Strapi's `files_related_mph`, in the order given. */
const mediaRelation = (
  key: string,
  relation: string,
  multiple: boolean,
  fileModel: string,
): WireRelation => ({
  key,
  relation,
  kind: multiple ? "mediaMany" : "mediaOne",
  model: fileModel,
  foreignKey: null,
  uid: FILE_UID,
  holder: "self",
  draftPublish: false,
  localized: false,
  order: null,
  inverseOrder: null,
});

const mediaRelations = (ct: ContentType, fileModel: string): WireRelation[] =>
  ct.fields.flatMap((f) =>
    f.type === "media"
      ? [mediaRelation(fieldApiName(f), f.name, f.multiple === true, fileModel)]
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
        // The Eloquent relation goes by the IR's name, the wire key by the one the API sends.
        const key = inverseApiName(g) ?? g.inverse;
        if (g.relationKind === "manyToOne") {
          const base = snakeColumn(g.name);
          inverse.push(
            entry(key, g.inverse, "hasMany", other, `${base}_id`, "target", {
              order: { table: table(other), column: `${base}_ord` },
              inverseOrder: null,
            }),
          );
        } else if (g.relationKind === "oneToOne") {
          inverse.push(
            entry(key, g.inverse, "hasOne", other, `${snakeColumn(g.name)}_id`, "target"),
          );
        } else if (g.relationKind === "oneToMany") {
          const base = snakeColumn(g.inverse);
          inverse.push(
            entry(key, g.inverse, "belongsTo", other, `${base}_id`, "self", {
              order: null,
              inverseOrder: { table: table(ct), column: `${base}_ord` },
            }),
          );
        } else {
          inverse.push(
            entry(key, g.inverse, "belongsToMany", other, null, "target", pivotOrder(ct, other)),
          );
        }
      }
    }
  }
  return [...own, ...inverse];
};
