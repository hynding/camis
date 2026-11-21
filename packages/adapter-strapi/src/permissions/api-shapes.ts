import { fieldApiName, type ContentType, type Field, type IrDocument } from "@camis/ir-schema";
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
  | "polymorphic"
  | "media"
  | { component: string; repeatable: boolean }
  | { zone: string[] };

const shapeOf = (f: Field, uids: ReadonlyMap<string, string>): ApiAttributeShape => {
  if (f.type === "relation" || f.type === "polymorphicInverse") return "relation";
  if (f.type === "polymorphicRelation") return "polymorphic";
  if (f.type === "media") return "media";
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
        ...Object.keys(inverses.get(ct.name) ?? {}).map((name): [string, ApiAttributeShape] => [
          name,
          "relation",
        ]),
      ]),
    ]),
    ...[...components.values()].map((c): [string, Record<string, ApiAttributeShape>] => [
      uids.get(c.name) ?? c.name,
      ordered(attributes(c.fields)),
    ]),
  ]);
};
