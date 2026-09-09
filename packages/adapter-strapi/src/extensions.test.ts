import { describe, expect, it } from "vitest";
import { usersPermissionsExtensionFile } from "./extensions";

describe("usersPermissionsExtensionFile", () => {
  const file = usersPermissionsExtensionFile({
    tasks: {
      type: "relation",
      relation: "oneToMany",
      target: "api::task.task",
      mappedBy: "assignee",
    },
  });

  it("writes the plugin extension Strapi loads", () => {
    expect(file.path).toBe("src/extensions/users-permissions/strapi-server.ts");
  });

  it("adds the inverse attributes to the plugin's user schema and returns the plugin", () => {
    expect(file.content).toContain("plugin.contentTypes.user.schema.attributes");
    expect(file.content).toContain('"target": "api::task.task"');
    expect(file.content).toContain('"mappedBy": "assignee"');
    expect(file.content).toContain("return plugin;");
  });

  it("carries the generated marker and no stray blank-line indentation", () => {
    expect(file.content.startsWith("// @camis:generated")).toBe(true);
    expect(file.content).not.toMatch(/\n[ \t]+\n/);
  });
});
