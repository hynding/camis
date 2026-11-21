import type { IrBundle } from "@camis/permissions";

/**
 * A Laravel-style fixture as the Strapi API style can take it: that style keeps `publishedAt` for
 * itself, so the fixture's own `publishedAt` field is `releasedAt`, and nothing else changes.
 */
export const forStrapiApiStyle = (bundle: IrBundle): IrBundle => ({
  ...bundle,
  document: {
    ...bundle.document,
    contentTypes: bundle.document.contentTypes.map((ct) => ({
      ...ct,
      fields: ct.fields.map((f) => (f.name === "publishedAt" ? { ...f, name: "releasedAt" } : f)),
    })),
  },
});
