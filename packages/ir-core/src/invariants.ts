import type { ContentType, IrDocument, IrError } from "@camis/ir-schema";

export const validateInvariants = (doc: IrDocument): IrError[] => {
  const errors: IrError[] = [];
  const typeNames = new Set(doc.contentTypes.map((t) => t.name));
  const componentNames = new Set(doc.components.map((c) => c.name));

  const checkFields = (fields: ContentType["fields"], location: IrError["location"]) => {
    for (const f of fields) {
      if (f.type === "relation" && !typeNames.has(f.target)) {
        errors.push({
          code: "unknown_relation_target",
          message: `relation target "${f.target}" does not exist`,
          location: { ...location, field: f.name },
          path: [],
        });
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
    }
  };

  for (const ct of doc.contentTypes) checkFields(ct.fields, { contentType: ct.name });
  for (const c of doc.components)
    checkFields(c.fields as ContentType["fields"], { component: c.name });
  return errors;
};
