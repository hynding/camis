import { describe, expect, it } from "vitest";
import { validate } from "@camis/ir-core";
import { parseRolesFile, validateBundle } from "@camis/permissions";
import { PROJECT_TEMPLATES, projectTemplate } from "./index";

describe("project templates", () => {
  it.each(PROJECT_TEMPLATES)("%s: the IR and roles validate together", (name) => {
    const template = projectTemplate(name);
    const document = validate(template.document);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    const roles = parseRolesFile(template.roles);
    expect(roles.ok).toBe(true);
    if (!roles.ok) return;
    const bundle = validateBundle({
      document: document.value,
      roles: roles.value.roles,
      ...(roles.value.defaultRole !== undefined ? { defaultRole: roles.value.defaultRole } : {}),
    });
    expect(bundle.ok).toBe(true);
  });

  it.each(PROJECT_TEMPLATES)("%s: has Strapi's public and authenticated roles", (name) => {
    const { roles } = projectTemplate(name);
    expect(roles.defaultRole).toBe("authenticated");
    expect(roles.roles.map((r) => r.name)).toEqual(["public", "authenticated"]);
  });

  it("vanilla starts with an empty content model", () => {
    const { document } = projectTemplate("vanilla");
    expect(document.contentTypes).toEqual([]);
    expect(document.components).toEqual([]);
  });

  it("example is create-strapi-app's blog", () => {
    const { document } = projectTemplate("example");
    expect(document.contentTypes.map((ct) => ct.name).sort()).toEqual([
      "About",
      "Article",
      "Author",
      "Category",
      "Global",
    ]);
    expect(document.components.map((c) => c.name).sort()).toEqual([
      "Media",
      "Quote",
      "RichText",
      "Seo",
      "Slider",
    ]);
  });

  it("example lets the public role read every content type, like Strapi's seeded example", () => {
    const { document, roles } = projectTemplate("example");
    const publicRole = roles.roles.find((r) => r.name === "public");
    expect(publicRole?.grants.map((g) => g.contentType).sort()).toEqual(
      document.contentTypes.map((ct) => ct.name).sort(),
    );
    for (const grant of publicRole?.grants ?? []) expect(grant.actions).toEqual(["read"]);
  });
});
