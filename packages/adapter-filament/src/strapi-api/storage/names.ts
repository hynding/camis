import type { Component, ContentType, Field } from "@camis/ir-schema";
import { pluralize, snakeCase } from "@camis/ir-core";
import { kebab } from "../names";

/**
 * A relation field, narrowed out of the IR's `Field` union. Kept local (rather than exported
 * from `@camis/ir-schema`) because only this Strapi-storage naming layer needs the narrowed
 * type; the schema package's public surface stays the discriminated union.
 */
export type RelationField = Extract<Field, { type: "relation" }>;

/**
 * Strapi's physical table for a content type. Must match the Strapi target's own default
 * (`packages/strapi-schema/src/component-schema.ts` uses the identical helpers for components)
 * so a Laravel app reading Strapi's database lands on the same table Strapi itself created.
 */
export const strapiTable = (ct: ContentType): string =>
  ct.names?.collection ?? snakeCase(ct.names?.plural ?? pluralize(ct.name));

/** The content type's singular snake name, used to build relation-table foreign keys. */
export const strapiSingular = (ct: ContentType): string => snakeCase(ct.name);

/** Strapi's link table for a relation field, e.g. `notes_owner_lnk`. */
export const linkTable = (ct: ContentType, relation: string): string =>
  `${strapiTable(ct)}_${snakeCase(relation)}_lnk`;

/**
 * Column names on a relation's link table. `ord` (the ordering column Strapi adds for the
 * inverse side of a relation) is present only when the field declares an `inverse` — omitted
 * entirely (not `undefined`) so it round-trips under `exactOptionalPropertyTypes`.
 */
export const linkColumns = (
  ct: ContentType,
  f: RelationField,
): { local: string; foreign: string; ord?: string } => {
  const local = `${strapiSingular(ct)}_id`;
  const foreign = `${snakeCase(f.target)}_id`;
  return f.inverse !== undefined
    ? { local, foreign, ord: `${strapiSingular(ct)}_ord` }
    : { local, foreign };
};

/** One owning relation's Strapi link table, named by this module. */
export interface ControllerLink {
  relation: string;
  table: string;
  local: string;
  foreign: string;
  /** Present only when the relation declares an inverse (Strapi orders the inverse list). */
  ord?: string;
}

/**
 * A relation this content type owns — the side whose link-table row the generated code writes.
 * `manyToMany`/`oneToMany` are not owning in that sense (Task 11 reports them as capability
 * gaps), so only `manyToOne`/`oneToOne` survive.
 */
const isOwningRelation = (f: Field): f is RelationField =>
  f.type === "relation" && (f.relationKind === "manyToOne" || f.relationKind === "oneToOne");

/**
 * Every owning relation's link table, in IR field order — the single description of a content
 * type's link tables shared by the storage controller, the schema check and their tests.
 */
export const ownerLinks = (ct: ContentType): ControllerLink[] =>
  ct.fields
    .filter(isOwningRelation)
    .map((f) => ({ relation: f.name, table: linkTable(ct, f.name), ...linkColumns(ct, f) }));

/** The generic component-link table Strapi creates on a table that owns component fields. */
export const cmpsTable = (table: string): string => `${table}_cmps`;

/**
 * A component's physical table. Must match the Strapi target's own default
 * (`packages/strapi-schema/src/component-schema.ts`) byte-for-byte.
 */
export const componentTable = (c: Component): string =>
  c.names?.collection ?? `components_shared_${snakeCase(pluralize(c.name))}`;

/** Strapi's `component_type` discriminator string, e.g. `nutrition.nutrition-facts`. */
export const componentType = (c: Component): string =>
  `${c.names?.group ?? "shared"}.${kebab(c.name)}`;
