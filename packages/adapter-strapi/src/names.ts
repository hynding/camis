import type { ContentType } from "@camis/ir-schema";

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
