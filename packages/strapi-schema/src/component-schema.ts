import type { Component } from "@camis/ir-schema";
import { humanize, pluralize, snakeCase } from "@camis/ir-core";
import { toAttributes } from "./attributes";

export const componentSchema = (
  component: Component,
  builtinUsers: ReadonlySet<string> = new Set(),
  componentUids: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown> => ({
  collectionName:
    component.names?.collection ?? `components_shared_${snakeCase(pluralize(component.name))}`,
  info: {
    displayName: component.names?.display ?? humanize(component.name),
    ...(component.icon === undefined ? {} : { icon: component.icon }),
    ...(component.description === undefined ? {} : { description: component.description }),
  },
  options: {},
  attributes: toAttributes(component.fields, builtinUsers, componentUids),
});
