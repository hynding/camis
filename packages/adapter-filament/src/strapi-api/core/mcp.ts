import type { GeneratedFile } from "@camis/adapter-kernel";
import { runtimePhp } from "../../runtime-php";

/**
 * Strapi 5's MCP server (`server.mcp`): the endpoint, its JSON-RPC methods and the check of a
 * tool's arguments. The tools themselves are the content-manager's (content-manager/mcp.ts).
 */

/** Strapi's server.mcp.enabled: off until a deployment turns it on. */
export const mcpConfigKeys = (): string => `

    // Strapi's MCP server at /mcp (server.mcp.enabled), for clients signed in with an admin token.
    'mcp' => [
        'enabled' => (bool) env('CAMIS_MCP_ENABLED', false),
    ],`;

const RUNTIME_FILES = [
  "app/Http/Controllers/StrapiMcpController.php",
  "app/Support/StrapiMcpServer.php",
  "app/Support/StrapiMcpSchema.php",
  "app/Support/StrapiMcpError.php",
];

export const mcpServerFiles = (): GeneratedFile[] =>
  RUNTIME_FILES.map((path) => ({
    path,
    content: runtimePhp(new URL(`./php/${path}`, import.meta.url)),
  }));
