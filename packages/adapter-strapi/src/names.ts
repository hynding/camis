import type { Component, ContentType } from "@camis/ir-schema";

export interface StrapiNames {
  singularName: string;
  pluralName: string;
  collectionName: string;
  displayName: string;
  uid: string;
}

// Strapi uses kebab-case for singular/plural/UID segments; the same transform feeds
// relation target UIDs, so it lives here as the one source of truth for name casing.
export const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

// Assumes a normalized ContentType (names.* populated by ir-core); falls back to the
// canonical name if an override is missing.
export const strapiNames = (ct: ContentType): StrapiNames => {
  const singularName = kebab(ct.name);
  const pluralName = kebab(ct.names?.plural ?? ct.name);
  return {
    singularName,
    pluralName,
    collectionName: ct.names?.collection ?? pluralName,
    displayName: ct.names?.display ?? ct.name,
    uid: `api::${singularName}.${singularName}`,
  };
};

// A component's uid is `<category>.<kebab-name>`, and the category is the folder its JSON file
// lives in — `names.group`, defaulting to "shared". Emitting the two from one place is what keeps
// a reference resolvable.
export const componentCategory = (component: Component): string =>
  component.names?.group ?? "shared";

export const componentUid = (component: Component): string =>
  `${componentCategory(component)}.${kebab(component.name)}`;

/** name → uid for every component in a document, for the attribute emitter's lookups. */
export const componentUids = (components: readonly Component[]): ReadonlyMap<string, string> =>
  new Map(components.map((c) => [c.name, componentUid(c)]));
