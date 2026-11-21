import {
  fieldApiName,
  type ContentType,
  type Field,
  type IrDocument,
  type RelationKind,
} from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { componentUids, strapiNames, synthesizedInverses } from "@camis/strapi-schema";
import { embedded } from "./api-reach";
import { codePointOrder } from "./code-point-order";

// Strapi and its database layer read more from a write's body than its attributes: `__pivot` in a
// relation or media item is spread into the join row, `id` in a component item updates that row,
// `documentId`, `locale` and `publishedAt` steer the document service. The controllers check a
// restricted caller's write against these tables first, so nothing but an attribute in one of
// Strapi's documented forms reaches the decisions, or Strapi.

/** How an attribute is written; see AttributeShape in the generated decisions. */
export type ApiAttributeShape =
  | "scalar"
  | "relation"
  | "toOneRelation"
  | "polymorphic"
  | "toOnePolymorphic"
  | "media"
  | "toOneMedia"
  | { component: string; repeatable: boolean }
  | { zone: string[] };

/** Strapi's "relates to one" kinds, whose write keeps the last entry it names. */
const TO_ONE: readonly unknown[] = ["oneToOne", "manyToOne"] satisfies RelationKind[];
const relationShape = (kind: unknown): ApiAttributeShape =>
  TO_ONE.includes(kind) ? "toOneRelation" : "relation";

const shapeOf = (f: Field, uids: ReadonlyMap<string, string>): ApiAttributeShape => {
  if (f.type === "relation") return relationShape(f.relationKind);
  if (f.type === "polymorphicInverse") return "relation";
  if (f.type === "polymorphicRelation") return f.many ? "polymorphic" : "toOnePolymorphic";
  // Strapi's media attribute holds one file unless it is `multiple`.
  if (f.type === "media") return f.multiple === true ? "media" : "toOneMedia";
  if (f.type === "component")
    return { component: uids.get(f.component) ?? f.component, repeatable: f.repeatable };
  if (f.type === "dynamicZone") return { zone: f.components.map((c) => uids.get(c) ?? c) };
  return "scalar";
};

const ordered = <T>(entries: [string, T][]): Record<string, T> =>
  Object.fromEntries(entries.sort(([a], [b]) => codePointOrder(a, b)));

/**
 * The writable attributes of each served type (its fields and the inverses Strapi gives it) and of
 * every component it embeds, by Strapi uid.
 */
export const projectShapes = (
  doc: IrDocument,
  served: readonly ContentType[],
): Record<string, Record<string, ApiAttributeShape>> => {
  const uids = componentUids(doc.components);
  const inverses = synthesizedInverses(doc);
  const attributes = (fields: readonly Field[]): [string, ApiAttributeShape][] =>
    fields.map((f) => [fieldApiName(f), shapeOf(f, uids)]);
  const components = new Map(
    served.flatMap((ct) => embedded(doc, ct.fields)).map((c) => [c.name, c] as const),
  );
  return ordered([
    ...served.map((ct): [string, Record<string, ApiAttributeShape>] => [
      strapiNames(ct).uid,
      ordered([
        ...attributes(ct.fields),
        ...Object.entries(inverses.get(ct.name) ?? {}).map(
          ([name, attribute]): [string, ApiAttributeShape] => [
            name,
            relationShape((attribute as { relation?: unknown }).relation),
          ],
        ),
      ]),
    ]),
    ...[...components.values()].map((c): [string, Record<string, ApiAttributeShape>] => [
      uids.get(c.name) ?? c.name,
      ordered(attributes(c.fields)),
    ]),
  ]);
};

const LINKS: readonly Field["type"][] = [
  "relation",
  "polymorphicRelation",
  "polymorphicInverse",
  "media",
];

/**
 * The content types whose writes the generated controller must check the body of: each with a
 * relation or media field (its own, an embedded component's, or an inverse Strapi gives it) that
 * a role the rules restrict creates or updates, or that an `auth: false` route opens for either.
 * Strapi's database layer spreads an item's `__pivot` into the join row whatever type it is
 * written through, so without the check a role with create alone could link existing entries, or
 * a single type's writer name another row of it (a locale, the published version) in its join rows.
 */
export const linkWritten = (doc: IrDocument, roles: readonly Role[]): Set<string> => {
  const inverses = synthesizedInverses(doc);
  const links = (ct: ContentType): boolean =>
    Object.keys(inverses.get(ct.name) ?? {}).length > 0 ||
    [ct.fields, ...embedded(doc, ct.fields).map((c) => c.fields)].some((fields) =>
      fields.some((f) => LINKS.includes(f.type)),
    );
  const written = (ct: ContentType): boolean =>
    roles.some(
      (r) =>
        r.admin !== true &&
        r.grants.some(
          (g) =>
            g.contentType === ct.name &&
            (g.actions.includes("create") || g.actions.includes("update")),
        ),
    ) || (ct.options?.publicApiActions ?? []).some((a) => a === "create" || a === "update");
  return new Set(
    doc.contentTypes
      .filter((ct) => ct.builtin === undefined)
      .filter((ct) => links(ct) && written(ct))
      .map((ct) => ct.name),
  );
};
