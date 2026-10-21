import type { CapabilityGap, Component, ContentType, Field, IrDocument } from "@camis/ir-schema";

/** A scalar produced by flattening components; `path` is field-name segments from the owning table. */
export interface ExpandedScalar {
  path: string[];
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

/** A repeatable component reference, realized as a child table of the content type. */
export interface ExpandedTable {
  path: string[];
  scalars: ExpandedScalar[];
}

/** One component a dynamic zone may hold, realized as its own child table of the content type. */
export interface ExpandedZoneMember {
  component: Component;
  table: ExpandedTable;
}

/** A dynamic zone: an ordered list of items, each one of its member components. */
export interface ExpandedZone {
  name: string;
  members: ExpandedZoneMember[];
}

export interface ExpandedContentType {
  scalars: ExpandedScalar[];
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

/**
 * Expand a content type's component fields against the document's component definitions.
 * Non-repeatable components flatten (recursively) into prefixed embedded scalars; repeatable
 * components become child tables, and each component a dynamic zone holds becomes one more, keyed
 * by the zone. Relations and AI attachments inside components, and
 * repeatables nested inside repeatables, are bounded out as downgrade gaps. A flattened scalar
 * keeps its `required` verbatim and reports, via `alwaysPresent`, whether every component
 * reference above it is required.
 */
export const expandComponents = (doc: IrDocument, ct: ContentType): ExpandedContentType => {
  const byName = new Map<string, Component>(doc.components.map((c) => [c.name, c]));
  const out: ExpandedContentType = { scalars: [], tables: [], zones: [], gaps: [] };

  const walk = (
    component: Component,
    path: string[],
    sink: ExpandedScalar[],
    insideRepeatable: boolean,
    alwaysPresent: boolean,
  ): void => {
    for (const field of component.fields) {
      const location = { contentType: ct.name, component: component.name, field: field.name };
      if (field.type === "relation") {
        out.gaps.push(
          gapAt(
            "componentRelation",
            location,
            `relation "${field.name}" inside component "${component.name}" is not supported on relational targets; skipped.`,
          ),
        );
        continue;
      }
      if (field.type === "component") {
        const child = byName.get(field.component);
        if (!child) continue; // unreachable on validated IR (unknown_component_ref)
        if (field.repeatable) {
          if (insideRepeatable) {
            out.gaps.push(
              gapAt(
                "nestedRepeatable",
                location,
                `repeatable component "${field.name}" nested inside a repeatable component is not supported; skipped.`,
              ),
            );
            continue;
          }
          const table: ExpandedTable = { path: [...path, field.name], scalars: [] };
          out.tables.push(table);
          // A child-table row exists only when the item does, so required-ness inside it holds.
          walk(child, [], table.scalars, true, true);
        } else {
          walk(
            child,
            [...path, field.name],
            sink,
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
      sink.push({ path: [...path, field.name], field: stripAi(field), alwaysPresent });
    }
  };

  for (const field of ct.fields) {
    if (field.type === "dynamicZone") {
      const zone: ExpandedZone = { name: field.name, members: [] };
      for (const name of field.components) {
        const component = byName.get(name);
        if (!component) continue; // unreachable on validated IR
        // A member's table is keyed by the zone and the component: its rows exist only as items.
        const table: ExpandedTable = { path: [field.name, component.name], scalars: [] };
        walk(component, [], table.scalars, true, true);
        zone.members.push({ component, table });
      }
      out.zones.push(zone);
      continue;
    }
    if (field.type !== "component") continue;
    const component = byName.get(field.component);
    if (!component) continue; // unreachable on validated IR
    if (field.repeatable) {
      const table: ExpandedTable = { path: [field.name], scalars: [] };
      out.tables.push(table);
      walk(component, [], table.scalars, true, true);
    } else {
      walk(component, [field.name], out.scalars, false, field.required === true);
    }
  }
  return out;
};
