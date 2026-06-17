import type { Component } from "@camis/ir-schema";
import { humanize, pluralize, snakeCase } from "@camis/ir-core";
import { toAttributes } from "./attributes";

export const componentSchema = (component: Component): Record<string, unknown> => ({
  collectionName: `components_shared_${snakeCase(pluralize(component.name))}`,
  info: { displayName: humanize(component.name) },
  options: {},
  attributes: toAttributes(component.fields),
});
