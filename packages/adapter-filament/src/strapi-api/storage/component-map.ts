import type { Component, ContentType, FieldType, IrDocument } from "@camis/ir-schema";
import { camelPath } from "../../components";
import { snakeColumn } from "../../names";
import { cmpsTable, componentTable, componentType, strapiTable } from "./names";

/** A scalar field inside a component, named on every axis the runtime component loader needs. */
export interface MappedScalar {
  /** Camel-case wire-key path from the content-type root, e.g. `["facts", "calories"]`. */
  wireKey: string[];
  /** Phase-16 Filament flattened-column / child-table-column name (see `component-map.ts` rules). */
  flatAttribute: string;
  /** The scalar's own column name in its component's Strapi table. */
  column: string;
  type: FieldType;
}

/** One IR component field, resolved to Strapi's physical names and Phase 16's Filament names. */
export interface MappedComponent {
  /** IR field name on the owner ("amount", "facts", "additional"). */
  field: string;
  /** Camel-case wire-key path from the content type root; never resets at repeatable boundaries. */
  wireKey: string[];
  /** Snake path prefix used by Phase 16 flattening; only meaningful when `repeatable` is false. */
  flatPrefix: string[];
  /** Phase 16 child-relation name (repeatable only), e.g. `factsAdditional`. */
  relationName?: string;
  repeatable: boolean;
  /** The component's own Strapi table. */
  table: string;
  /** Strapi's `component_type` discriminator. */
  type: string;
  /** The component-link table on the OWNER (content table or parent component table). */
  cmpsTable: string;
  scalars: MappedScalar[];
  nested: MappedComponent[];
}

/**
 * Resolve a content type's component fields to Strapi's physical names and the Phase 16
 * Filament names, recursively. Order matches IR field order throughout — deterministic, no
 * sorting. A repeatable component nested inside a repeatable component is skipped (the kernel's
 * `expandComponents` already reports it as a capability gap; this pure naming layer does not
 * duplicate that).
 */
export const componentMap = (doc: IrDocument, ct: ContentType): MappedComponent[] => {
  const byName = new Map<string, Component>(doc.components.map((c) => [c.name, c]));

  const walk = (
    component: Component,
    field: string,
    repeatable: boolean,
    wireKeyParent: string[],
    flatBase: string[],
    ownerCmpsTable: string,
    insideRepeatable: boolean,
  ): MappedComponent => {
    const wireKey = [...wireKeyParent, field];
    const flatPrefix = [...flatBase, snakeColumn(field)];
    const childFlatBase = repeatable ? [] : flatPrefix;

    const scalars: MappedScalar[] = [];
    const nested: MappedComponent[] = [];
    for (const f of component.fields) {
      if (f.type === "relation") continue; // no observer/join seam inside components; kernel gaps it
      if (f.type === "component") {
        const child = byName.get(f.component);
        if (!child) continue; // unreachable on validated IR
        if (f.repeatable && insideRepeatable) continue; // nested-repeatable-in-repeatable: kernel gaps it
        nested.push(
          walk(
            child,
            f.name,
            f.repeatable,
            wireKey,
            childFlatBase,
            cmpsTable(componentTable(component)),
            insideRepeatable || repeatable,
          ),
        );
        continue;
      }
      const scalarWireKey = [...wireKey, f.name];
      const flatAttribute = repeatable
        ? snakeColumn(f.name)
        : [...flatPrefix, snakeColumn(f.name)].join("_");
      scalars.push({
        wireKey: scalarWireKey,
        flatAttribute,
        column: snakeColumn(f.name),
        type: f.type,
      });
    }

    const base: MappedComponent = {
      field,
      wireKey,
      flatPrefix,
      repeatable,
      table: componentTable(component),
      type: componentType(component),
      cmpsTable: ownerCmpsTable,
      scalars,
      nested,
    };
    return repeatable ? { ...base, relationName: camelPath(wireKey) } : base;
  };

  const out: MappedComponent[] = [];
  const ownerCmpsTable = cmpsTable(strapiTable(ct));
  for (const f of ct.fields) {
    if (f.type !== "component") continue;
    const component = byName.get(f.component);
    if (!component) continue; // unreachable on validated IR
    out.push(walk(component, f.name, f.repeatable, [], [], ownerCmpsTable, false));
  }
  return out;
};
