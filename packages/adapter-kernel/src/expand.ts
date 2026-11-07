import {
  fieldApiName,
  type CapabilityGap,
  type Component,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";

/** A scalar produced by flattening components; `path` is field-name segments from the owning table. */
export interface ExpandedScalar {
  path: string[];
  /** The same path in the keys its fields go by on the API. */
  apiPath: string[];
  field: Field;
  /**
   * True when every non-repeatable component reference on the path to this scalar is required,
   * so a row of the owning table always carries the scalar. Inside a repeatable component's own
   * child table the path restarts: the row exists only when the item does.
   *
   * A flattened column is shared by the whole embedded component, so it can only be NOT NULL
   * when both `field.required` and this hold. `field.required` alone is the IR's constraint on
   * the component *when present* — a validation concern the emitters must not lose.
   */
  alwaysPresent: boolean;
}

type RelationField = Extract<Field, { type: "relation" }>;

/**
 * A relation inside a component, held by the row the component's columns live on (the entry's,
 * or an item's); `path` is field-name segments from that row. Strapi's component relations go one
 * way, so it has no inverse.
 */
export interface ExpandedRelation {
  path: string[];
  /** The same path in the keys its fields go by on the API. */
  apiPath: string[];
  field: RelationField;
  /** The component declaring it. */
  component: Component;
}

/** A repeatable component reference, realized as a child table of the row holding it. */
export interface ExpandedTable {
  path: string[];
  /** The same path in the keys its fields go by on the API. */
  apiPath: string[];
  scalars: ExpandedScalar[];
  /** The component each of its rows is an item of. */
  component: Component;
  /** Relations inside the item, held by the item's row (with `componentRelations`). */
  relations: ExpandedRelation[];
  /** Repeatables inside the item: child tables of the item's table (with `nestedTables`). */
  tables: ExpandedTable[];
}

/**
 * What a target can store beyond flattened scalars and one level of child tables. Without them,
 * relations inside components and repeatables inside items are reported as gaps and skipped.
 */
export interface ExpandOptions {
  componentRelations?: boolean;
  nestedTables?: boolean;
}

/** One component a dynamic zone may hold, realized as its own child table of the content type. */
export interface ExpandedZoneMember {
  component: Component;
  table: ExpandedTable;
}

/** A dynamic zone: an ordered list of items, each one of its member components. */
export interface ExpandedZone {
  name: string;
  /** The key the zone goes by on the API. */
  apiName: string;
  members: ExpandedZoneMember[];
}

export interface ExpandedContentType {
  scalars: ExpandedScalar[];
  /** Relations inside embedded components, held by the entry's row (with `componentRelations`). */
  relations: ExpandedRelation[];
  tables: ExpandedTable[];
  zones: ExpandedZone[];
  gaps: CapabilityGap[];
}

const gapAt = (
  feature: string,
  location: CapabilityGap["location"],
  message: string,
): CapabilityGap => ({ feature, location, severity: "downgrade", message });

// AI generation targets top-level model observers/lifecycles; component scalars have no
// observer seam, so the ai attachment is stripped (with a gap) rather than silently kept.
const stripAi = (field: Field): Field => {
  const f = field as Field & { ai?: unknown };
  if (f.ai === undefined) return field;
  const rest = { ...f };
  delete rest.ai;
  return rest as Field;
};

/**
 * The field as a column emitter must see it: a flattened column is shared by the whole embedded
 * component, so it can only be NOT NULL when the component is always there. Behind an optional
 * component reference the component may be absent entirely, and `required` then constrains the
 * component when present — a validation concern, not a column one.
 */
export const columnField = (scalar: ExpandedScalar): Field => {
  if (scalar.alwaysPresent || scalar.field.required === undefined) return scalar.field;
  const rest = { ...scalar.field };
  delete rest.required;
  return rest;
};

/** Where a walk puts what it finds: the entry's own row, or an item's. */
interface Holder {
  scalars: ExpandedScalar[];
  relations: ExpandedRelation[];
  tables: ExpandedTable[];
}

const newTable = (path: string[], apiPath: string[], component: Component): ExpandedTable => ({
  path,
  apiPath,
  scalars: [],
  component,
  relations: [],
  tables: [],
});

/**
 * Expand a content type's component fields against the document's component definitions.
 * Non-repeatable components flatten (recursively) into prefixed embedded scalars of the row
 * holding them; repeatable components become child tables of that row, and each component a
 * dynamic zone holds becomes one more, keyed by the zone. Relations inside components (with
 * `componentRelations`) are held by the row the component lives on, and repeatables inside an
 * item (with `nestedTables`) are child tables of the item's table; without the options they, and
 * AI attachments inside components, are bounded out as downgrade gaps. A flattened scalar keeps
 * its `required` verbatim and reports, via `alwaysPresent`, whether every component reference
 * above it is required.
 */
export const expandComponents = (
  doc: IrDocument,
  ct: ContentType,
  options: ExpandOptions = {},
): ExpandedContentType => {
  const byName = new Map<string, Component>(doc.components.map((c) => [c.name, c]));
  const out: ExpandedContentType = { scalars: [], relations: [], tables: [], zones: [], gaps: [] };

  const walk = (
    component: Component,
    path: string[],
    apiPath: string[],
    holder: Holder,
    insideRepeatable: boolean,
    alwaysPresent: boolean,
  ): void => {
    for (const field of component.fields) {
      const location = { contentType: ct.name, component: component.name, field: field.name };
      if (field.type === "relation") {
        if (options.componentRelations !== true) {
          out.gaps.push(
            gapAt(
              "componentRelation",
              location,
              `relation "${field.name}" inside component "${component.name}" is not supported on relational targets; skipped.`,
            ),
          );
          continue;
        }
        holder.relations.push({
          path: [...path, field.name],
          apiPath: [...apiPath, fieldApiName(field)],
          field: oneWay(field, location),
          component,
        });
        continue;
      }
      if (field.type === "component") {
        const child = byName.get(field.component);
        if (!child) continue; // unreachable on validated IR (unknown_component_ref)
        if (field.repeatable) {
          if (insideRepeatable && options.nestedTables !== true) {
            out.gaps.push(
              gapAt(
                "nestedRepeatable",
                location,
                `repeatable component "${field.name}" nested inside a repeatable component is not supported; skipped.`,
              ),
            );
            continue;
          }
          const table = newTable([...path, field.name], [...apiPath, fieldApiName(field)], child);
          holder.tables.push(table);
          // A child-table row exists only when the item does, so required-ness inside it holds.
          walk(child, [], [], table, true, true);
        } else {
          walk(
            child,
            [...path, field.name],
            [...apiPath, fieldApiName(field)],
            holder,
            insideRepeatable,
            alwaysPresent && field.required === true,
          );
        }
        continue;
      }
      const hasAi = (field as Field & { ai?: unknown }).ai !== undefined;
      if (hasAi) {
        out.gaps.push(
          gapAt(
            "componentAiField",
            location,
            `AI attachment on "${field.name}" inside component "${component.name}" has no observer seam on relational targets; the field is emitted without AI.`,
          ),
        );
      }
      holder.scalars.push({
        path: [...path, field.name],
        apiPath: [...apiPath, fieldApiName(field)],
        field: stripAi(field),
        alwaysPresent,
      });
    }
  };

  // Strapi's component relations go one way; an inverse would have no field to live on.
  const oneWay = (field: RelationField, location: CapabilityGap["location"]): RelationField => {
    if (field.inverse === undefined) return field;
    out.gaps.push(
      gapAt(
        "componentRelationInverse",
        location,
        `relation "${field.name}" inside a component goes one way, as Strapi's do; its inverse "${field.inverse}" is not generated.`,
      ),
    );
    const rest = { ...field };
    delete rest.inverse;
    delete (rest as { inverseNames?: unknown }).inverseNames;
    return rest;
  };

  for (const field of ct.fields) {
    if (field.type === "dynamicZone") {
      const zone: ExpandedZone = { name: field.name, apiName: fieldApiName(field), members: [] };
      for (const name of field.components) {
        const component = byName.get(name);
        if (!component) continue; // unreachable on validated IR
        // A member's table is keyed by the zone and the component: its rows exist only as items.
        const table = newTable(
          [field.name, component.name],
          [fieldApiName(field), component.name],
          component,
        );
        walk(component, [], [], table, true, true);
        zone.members.push({ component, table });
      }
      out.zones.push(zone);
      continue;
    }
    if (field.type !== "component") continue;
    const component = byName.get(field.component);
    if (!component) continue; // unreachable on validated IR
    if (field.repeatable) {
      const table = newTable([field.name], [fieldApiName(field)], component);
      out.tables.push(table);
      walk(component, [], [], table, true, true);
    } else {
      walk(component, [field.name], [fieldApiName(field)], out, false, field.required === true);
    }
  }
  return out;
};
