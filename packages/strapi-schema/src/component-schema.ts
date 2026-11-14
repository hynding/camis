import type { Component } from "@camis/ir-schema";
import { pluralize, snakeCase } from "@camis/ir-core";
import { componentDisplayName } from "./names";
import { toAttributes } from "./attributes";

export const componentSchema = (
  component: Component,
  builtinUsers: ReadonlySet<string> = new Set(),
  componentUids: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown> => ({
  collectionName:
    component.names?.collection ?? `components_shared_${snakeCase(pluralize(component.name))}`,
  info: {
    displayName: componentDisplayName(component),
    ...(component.icon === undefined ? {} : { icon: component.icon }),
    ...(component.description === undefined ? {} : { description: component.description }),
  },
  options: {},
  attributes: toAttributes(component.fields, builtinUsers, componentUids),
});
