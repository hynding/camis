import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { mediaMcpTools } from "./mcp-tools";

// tools/list of strapi-php's MCP server, read with a token holding every Media Library action.
const recorded = JSON.parse(
  gunzipSync(
    readFileSync(new URL("../__fixtures__/mcp/tools-list.strapi-php.json.gz", import.meta.url)),
  ).toString("utf8"),
) as { name: string }[];

describe("the Media Library's MCP tools", () => {
  const tools = mediaMcpTools();

  it("lists the tools strapi-php lists, in its order", () => {
    expect(tools.map((t) => t.name)).toEqual(
      recorded.map((t) => t.name).filter((n) => n.startsWith("media_")),
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
      expect(listed, tool.name).toEqual(recorded.find((t) => t.name === tool.name));
    }
  });

  it("asks for the Media Library's actions, which name no subject", () => {
    expect(tools.find((t) => t.name === "media_list_assets")!.policies).toEqual([
      { action: "plugin::upload.read" },
    ]);
    expect(tools.find((t) => t.name === "media_create_folder")!.policies).toEqual([
      { action: "plugin::upload.assets.create" },
    ]);
    expect(tools.find((t) => t.name === "media_delete_folder")!.policies).toEqual([
      { action: "plugin::upload.assets.update" },
    ]);
  });

  it("keeps the messages Strapi gives a refused key or a folder name", () => {
    const rename = tools.find((t) => t.name === "media_rename_folder")!;
    expect(rename.messages).toEqual({
      keys: [
        {
          keys: ["parent"],
          message:
            "media_rename_folder only changes a folder name. Use media_move_folder to change a folder location.",
        },
      ],
      patterns: {
        "^[^\\/]+$": "Folder name cannot contain slashes.",
        "^(?! ).+(?<! )$": "Folder name cannot start or end with a whitespace.",
      },
    });
  });
});
