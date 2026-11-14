import { fieldApiName, type Component } from "@camis/ir-schema";
import { componentUid } from "./strapi-api/core/names";

/** A form component inside a component, with the field-name path to it from the component. */
export interface LaidOutField {
  path: readonly string[];
  code: string;
}

/**
 * A component's form fields handed to `StrapiContentManager::component`, which lays them out by
 * the component's own view (Strapi's `components::<uid>` configuration): keyed by each field's key
 * on the API, as the view names them, in the component's field order. A component embedded in it
 * is laid out by its own view in turn. `components` is the project's, to find an embedded one by.
 */
export const componentLayout = (
  component: Component,
  entries: readonly LaidOutField[],
  components: readonly Component[],
  pad: string,
): string => {
  const groups = new Map<string, LaidOutField[]>();
  for (const name of component.fields.map((f) => f.name)) groups.set(name, []);
  for (const entry of entries) {
    const name = entry.path[0] ?? "";
    groups.set(name, [...(groups.get(name) ?? []), entry]);
  }
  const embedded: string[] = [];
  const rows = [...groups].flatMap(([name, group]) => {
    if (group.length === 0) return [];
    const field = component.fields.find((f) => f.name === name);
    const key = field === undefined ? name : fieldApiName(field);
    const inner =
      field?.type === "component" && field.repeatable !== true
        ? components.find((c) => c.name === field.component)
        : undefined;
    if (inner !== undefined && group.every((e) => e.path.length > 1)) {
      embedded.push(key);
      const nested = group.map((e) => ({ path: e.path.slice(1), code: e.code }));
      return [`${pad}    '${key}' => ${componentLayout(inner, nested, components, `${pad}    `)},`];
    }
    const list = group
      .map((e) => `${pad}        ${e.code.replace(/\n/g, `\n${pad}    `)},`)
      .join("\n");
    return [`${pad}    '${key}' => [\n${list}\n${pad}    ],`];
  });
  const named = embedded.length === 0 ? "" : `, [${embedded.map((k) => `'${k}'`).join(", ")}]`;
  return `StrapiContentManager::component('${componentUid(component)}', [\n${rows.join("\n")}\n${pad}]${named})`;
};
