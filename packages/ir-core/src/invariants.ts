import type { Component, ContentType, IrDocument, IrError } from "@camis/ir-schema";
import { aiPlaceholders } from "@camis/ir-schema";

const findDuplicates = (names: string[]): string[] => {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return [...dupes];
};

const componentEdges = (components: Component[]): Map<string, string[]> => {
  const edges = new Map<string, string[]>();
  for (const c of components) {
    edges.set(
      c.name,
      c.fields.flatMap((f) => (f.type === "component" ? [f.component] : [])),
    );
  }
  return edges;
};

const hasCycle = (edges: Map<string, string[]>): boolean => {
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=in-stack 2=done
  const visit = (node: string): boolean => {
    if (state.get(node) === 1) return true;
    if (state.get(node) === 2) return false;
    state.set(node, 1);
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    state.set(node, 2);
    return false;
  };
  return [...edges.keys()].some(visit);
};

export const validateInvariants = (doc: IrDocument): IrError[] => {
  const errors: IrError[] = [];
  const typeByName = new Map(doc.contentTypes.map((t) => [t.name, t] as const));
  const componentNames = new Set(doc.components.map((c) => c.name));

  const checkFields = (fields: ContentType["fields"], location: IrError["location"]) => {
    for (const f of fields) {
      if (f.type === "relation") {
        if (!typeByName.has(f.target)) {
          errors.push({
            code: "unknown_relation_target",
            message: `relation target "${f.target}" does not exist`,
            location: { ...location, field: f.name },
            path: [],
          });
        } else if (
          f.inverse !== undefined &&
          typeByName.get(f.target)!.fields.some((tf) => tf.name === f.inverse)
        ) {
          errors.push({
            code: "inverse_field_collision",
            message: `inverse field "${f.inverse}" already exists on "${f.target}"`,
            location: { ...location, field: f.name },
            path: [],
          });
        }
      }
      if (f.type === "component" && !componentNames.has(f.component)) {
        errors.push({
          code: "unknown_component_ref",
          message: `component "${f.component}" does not exist`,
          location: { ...location, field: f.name },
          path: [],
        });
      }
      if (f.type === "dynamicZone") {
        for (const c of f.components) {
          if (!componentNames.has(c)) {
            errors.push({
              code: "unknown_component_ref",
              message: `component "${c}" does not exist`,
              location: { ...location, field: f.name },
              path: [],
            });
          }
        }
      }
      const af = f as { ai?: { prompt: string }; computed?: unknown };
      if (af.ai) {
        if (af.computed !== undefined) {
          errors.push({
            code: "ai_computed_conflict",
            message: `field "${f.name}" cannot be both an AI field and computed`,
            location: { ...location, field: f.name },
            path: [],
          });
        }
        const scalarNames = new Set(
          fields
            .filter(
              (g) => g.type !== "relation" && g.type !== "component" && g.type !== "dynamicZone",
            )
            .map((g) => g.name),
        );
        for (const src of aiPlaceholders(af.ai.prompt)) {
          if (src === f.name || !scalarNames.has(src)) {
            errors.push({
              code: "unknown_ai_source",
              message: `AI field "${f.name}" references unknown source "${src}"`,
              location: { ...location, field: f.name },
              path: [],
            });
          }
        }
      }
    }
  };

  for (const ct of doc.contentTypes) checkFields(ct.fields, { contentType: ct.name });
  for (const c of doc.components)
    checkFields(c.fields as ContentType["fields"], { component: c.name });

  for (const name of findDuplicates(doc.contentTypes.map((t) => t.name))) {
    errors.push({
      code: "duplicate_content_type_name",
      message: `duplicate content type "${name}"`,
      location: { contentType: name },
      path: [],
    });
  }
  for (const name of findDuplicates(doc.components.map((c) => c.name))) {
    errors.push({
      code: "duplicate_component_name",
      message: `duplicate component "${name}"`,
      location: { component: name },
      path: [],
    });
  }
  if (hasCycle(componentEdges(doc.components))) {
    errors.push({
      code: "cyclic_component_reference",
      message: "component references form a cycle",
      location: { rule: "acyclic_components" },
      path: [],
    });
  }
  return errors;
};
