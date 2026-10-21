import type { Component, ContentType } from "@camis/ir-schema";
import { pluralize } from "@camis/ir-core";

export const kebab = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();

/** Strapi REST path segment: kebab-case plural (`ActivitySessions` → `activity-sessions`). */
export const routePath = (ct: ContentType): string => kebab(ct.names?.plural ?? pluralize(ct.name));

/** Wire keys are the IR field names (already camelCase); one seam for all of them. */
export const camelKey = (fieldName: string): string => fieldName;

/** A component's Strapi uid, `<category>.<kebab-name>`: the category is `names.group`, else "shared". */
export const componentUid = (component: Component): string =>
  `${component.names?.group ?? "shared"}.${kebab(component.name)}`;
