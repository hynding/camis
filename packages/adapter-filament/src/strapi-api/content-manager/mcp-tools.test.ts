import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { strapiApiBundle } from "../__fixtures__/strapi-api";
import { contentManagerMcpTools, LOCALE_PLACEHOLDER, slugifyUidForMcpToolName } from "./mcp-tools";

// tools/list of strapi-php's MCP server for the same content types, with locales en (default)
// and fr installed, read with a token holding every content-manager action.
const recorded = JSON.parse(
  gunzipSync(
    readFileSync(new URL("../__fixtures__/mcp/tools-list.strapi-php.json.gz", import.meta.url)),
  ).toString("utf8"),
) as { name: string }[];

const LOCALE = {
  default: "en",
  description: 'Locale code. Available: en, fr. Defaults to "en".',
  type: "string",
  enum: ["en", "fr"],
};

/** What the app serves: the placeholder replaced by the installed locales. */
const served = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(served);
  if (value === null || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  if (o.description === LOCALE_PLACEHOLDER) return LOCALE;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, served(v)]));
};

describe("the content-manager's MCP tools", () => {
  const tools = contentManagerMcpTools(strapiApiBundle.document);

  it("slugs a uid as Strapi names its tools", () => {
    expect(slugifyUidForMcpToolName("api::article.article")).toBe("article");
    expect(slugifyUidForMcpToolName("api::writer.editor")).toBe("writer_editor");
    expect(slugifyUidForMcpToolName("plugin::users-permissions.user")).toBe(
      "plugin-users-permissions_user",
    );
  });

  it("lists the tools strapi-php lists, in its order", () => {
    expect(tools.map((t) => t.name)).toEqual(
      recorded.map((t) => t.name).filter((n) => !n.startsWith("media_")),
    );
  });

  it("describes each one as strapi-php does, schemas and all", () => {
    for (const tool of tools) {
      const listed = {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      };
      expect(served(listed), tool.name).toEqual(recorded.find((t) => t.name === tool.name));
    }
  });

  it("guards each tool with Strapi's content-manager action on its type", () => {
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("write_global")!.policies).toEqual([
      { action: "plugin::content-manager.explorer.create", subject: "api::global.global" },
      { action: "plugin::content-manager.explorer.update", subject: "api::global.global" },
    ]);
    expect(byName.get("unpublish_post")!.policies).toEqual([
      { action: "plugin::content-manager.explorer.publish", subject: "api::post.post" },
    ]);
    expect(byName.get("discard_post_draft")!.policies).toEqual([
      { action: "plugin::content-manager.explorer.update", subject: "api::post.post" },
    ]);
  });
});
