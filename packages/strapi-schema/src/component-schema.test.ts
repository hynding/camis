import { describe, expect, it } from "vitest";
import type { Component } from "@camis/ir-schema";
import { componentSchema } from "./component-schema";

const seo: Component = { name: "SeoMeta", fields: [{ type: "string", name: "metaTitle" }] };

describe("componentSchema", () => {
  it("builds a Strapi component json", () => {
    expect(componentSchema(seo)).toEqual({
      collectionName: "components_shared_seo_metas",
      info: { displayName: "Seo Meta" },
      options: {},
      attributes: { metaTitle: { type: "string" } },
    });
  });

  // Strapi keeps a component's display name, icon and description in its info.
  it("writes the display name, icon and description the component has", () => {
    expect(
      componentSchema({
        ...seo,
        names: { display: "SEO" },
        icon: "search",
        description: "Search engine metadata",
      }).info,
    ).toEqual({ displayName: "SEO", icon: "search", description: "Search engine metadata" });
  });
});
