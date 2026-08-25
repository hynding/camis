import type { CapabilityGap, Component, ContentType, Field, IrDocument } from "@camis/ir-schema";

/** A scalar produced by flattening components; `path` is field-name segments from the owning table. */
export interface ExpandedScalar {
  path: string[];
  field: Field;
}

/** A repeatable component reference, realized as a child table of the content type. */
export interface ExpandedTable {
  path: string[];
  scalars: ExpandedScalar[];
}

export interface ExpandedContentType {
  scalars: ExpandedScalar[];
  tables: ExpandedTable[];
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
 * Expand a content type's component fields against the document's component definitions.
 * Non-repeatable components flatten (recursively) into prefixed embedded scalars; repeatable
 * components become child tables. Relations and AI attachments inside components, and
 * repeatables nested inside repeatables, are bounded out as downgrade gaps.
 */
export const expandComponents = (doc: IrDocument, ct: ContentType): ExpandedContentType => {
  const byName = new Map<string, Component>(doc.components.map((c) => [c.name, c]));
  const out: ExpandedContentType = { scalars: [], tables: [], gaps: [] };

  const walk = (
    component: Component,
    path: string[],
    sink: ExpandedScalar[],
    insideRepeatable: boolean,
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
          walk(child, [], table.scalars, true);
        } else {
          walk(child, [...path, field.name], sink, insideRepeatable);
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
      sink.push({ path: [...path, field.name], field: stripAi(field) });
    }
  };

  for (const field of ct.fields) {
    if (field.type !== "component") continue;
    const component = byName.get(field.component);
    if (!component) continue; // unreachable on validated IR
    if (field.repeatable) {
      const table: ExpandedTable = { path: [field.name], scalars: [] };
      out.tables.push(table);
      walk(component, [], table.scalars, true);
    } else {
      walk(component, [field.name], out.scalars, false);
    }
  }
  return out;
};
