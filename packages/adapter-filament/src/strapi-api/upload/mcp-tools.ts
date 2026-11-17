import { z } from "zod/v4";
import { mcpJsonSchema, type McpMessages, type McpTool } from "../content-manager/mcp-tools";
import { FILE_UID } from "./media-runtime";

/**
 * The Media Library tools of Strapi 5's MCP server, as its `tools/list` describes them: a port of
 * the upload plugin's `server/src/mcp/register-upload-mcp-tools.ts` and its schemas, built with
 * Zod 4 so the JSON Schemas are Strapi's own. Assets and folders are not documents: each is named
 * by its numeric id.
 */

// Strapi's words, kept as its tools/list gives them.
const DESCRIPTIONS = {
  media_list_assets:
    "List Media Library assets with pagination, folder / mime type / name filters and sorting. Assets are identified by a numeric id — media files are not documents and have no documentId.",
  media_get_asset:
    "Get a single Media Library asset by its numeric id. Media files are not documents: use the numeric id, not a documentId.",
  media_list_folders:
    "List the Media Library folder structure as a nested tree. Folders are identified by a numeric id; pass one as `folderId` to media_list_assets to list its contents.",
  media_update_asset:
    "Update the editable metadata of a Media Library asset, identified by its numeric id. Only name, alternativeText and caption can be written: use media_move_assets to change an asset's folder, and note that url, mime, size and the file contents are owned by the upload provider and cannot be edited over MCP.",
  media_move_assets:
    "Move Media Library assets into a different folder, in bulk. Takes `ids` — an array of numeric ASSET ids — and `folder`, the numeric id of the destination; pass `folder: null` to move them to the media library root. Both are required: use an array of one to move a single asset, and say null explicitly for the root.\n\nTakes ASSET ids only. Media files are not documents: use numeric ids, not documentIds.\n\nNEVER PASS A FOLDER ID. Asset ids and folder ids are separate, independently numbered namespaces, and the SAME NUMBER OFTEN NAMES BOTH an asset and a folder. This tool always reads the number as an ASSET id: hand it a folder id and it will move whichever unrelated asset happens to share that number, reporting that move as a success, while leaving the folder exactly where it was. Nothing in the request can express which one you meant, so the server cannot catch this for you — only an id matching no asset at all is reported as failed. Take ids only from media_list_assets or media_get_asset, never from media_list_folders, and use media_move_folder to move a folder (which carries its whole subtree).\n\nMoving changes the folder only. Names, alt text, captions and the assets' public URLs are unaffected, so nothing referencing them breaks — use media_update_asset to edit metadata.\n\nPARTIAL SUCCESS IS POSSIBLE: a bad id among good ones does NOT roll the valid moves back. The response always reports `moved` (the assets that were moved) and `failed` (each remaining id with a reason), which together account for every id you passed — so retry only the ids in `failed`, and treat `moved` as done. This holds even when nothing moved at all: `moved` is then empty and every id is in `failed`. The one error that rejects the whole call is a destination folder that does not exist, which is checked before anything is moved.",
  media_delete_assets:
    'DESTRUCTIVE AND IRREVERSIBLE. Permanently deletes Media Library assets by numeric id, in bulk — from the database AND from the storage provider, along with every generated thumbnail and size variant. There is no undo, no trash and no recycle bin. The deleted files stop being served immediately, so any live entry, page or export still referencing one will break.\n\nWHETHER AN ASSET IS USED IN PUBLISHED CONTENT CANNOT BE CHECKED: Strapi does not expose "used in" information over this API, so this tool cannot tell you whether an asset is referenced by any entry, and a successful delete is NOT evidence that nothing was using it. Confirm with the user before deleting.\n\nCall it first WITHOUT `dryRun` (or with `dryRun: true`) to preview: nothing is deleted and the response lists exactly which assets WOULD be removed, and how many. Report those to the user, and only then call it again with `dryRun: false` to actually delete.\n\nTakes `ids`, an array of numeric ASSET ids — use an array of one to delete a single asset. Media files are not documents: use numeric ids, not documentIds.\n\nNEVER PASS A FOLDER ID. Asset ids and folder ids are separate, independently numbered namespaces, and the SAME NUMBER OFTEN NAMES BOTH an asset and a folder. This tool always reads the number as an ASSET id: hand it a folder id and it will silently delete whichever unrelated asset happens to share that number, while leaving the folder untouched. Nothing in the request can express which one you meant, so the server cannot catch this for you — only an id matching no asset at all is reported as failed. Take ids only from media_list_assets or media_get_asset, never from media_list_folders, and use media_delete_folder to delete a folder. If you are not certain an id came from media_list_assets, run the dry run and check the returned name and folder before deleting.\n\nPARTIAL SUCCESS IS POSSIBLE: a bad id among good ones does NOT roll the completed deletions back, and those cannot be undone. The response always reports `deleted` (the assets removed, described in full because they can no longer be read back) and `failed` (each remaining id with a reason), which together account for every id you passed — so retry only the ids in `failed`. This holds on the dry run too, which reports the same split before anything is destroyed.',
  media_create_folder:
    "Create a Media Library folder, optionally inside an existing one. Folders are identified by a numeric id: pass `parent` to nest the new folder, or omit it to create the folder at the media library root. The name must be unique among its siblings and cannot contain slashes.",
  media_rename_folder:
    "Rename a Media Library folder, identified by its numeric id. Changes the folder name only and leaves its location, its contents and their URLs untouched — use media_move_folder to change which folder it sits in. The new name must be unique among the folder's siblings.",
  media_move_folder:
    "Move a Media Library folder into a different parent folder, identified by numeric ids. The folder keeps its name and carries all of its subfolders and files with it; pass `parent: null` to move it to the media library root. A folder cannot be moved into itself or into one of its own descendants. Use media_rename_folder to change the name instead.",
  media_delete_folder:
    'DESTRUCTIVE AND IRREVERSIBLE. Deletes Media Library folders by numeric id and CASCADES: every subfolder and every file inside them is permanently deleted from the database and from the storage provider. There is no undo, no trash and no recycle bin, and the deleted files stop being served — any live entry or page still referencing one will break.\n\nWHETHER THE CONTAINED ASSETS ARE USED IN PUBLISHED CONTENT CANNOT BE CHECKED: Strapi does not expose "used in" information over this API, so this tool cannot tell you whether a file is referenced by an entry. Confirm with the user before deleting.\n\nCall it first WITHOUT `dryRun` (or with `dryRun: true`) to preview: nothing is deleted and the response reports how many folders and files WOULD be removed. Only after reporting those counts should you call it again with `dryRun: false` to actually delete. Takes FOLDER ids only — asset ids are a separate namespace of integers; use media_delete_assets for individual assets. All or nothing: if ANY id does not resolve to a folder the whole call is rejected and nothing is deleted, so a list mixing folder and asset ids never deletes half of what it names.',
};

const ACTIONS = {
  read: "plugin::upload.read",
  create: "plugin::upload.assets.create",
  update: "plugin::upload.assets.update",
} as const;

const ALLOWED_SORT_STRINGS = [
  "createdAt:DESC",
  "createdAt:ASC",
  "name:ASC",
  "name:DESC",
  "updatedAt:DESC",
  "updatedAt:ASC",
] as const;

const NO_SLASHES = "^[^\\/]+$";
const NO_SURROUNDING_SPACE = "^(?! ).+(?<! )$";

// --- input -------------------------------------------------------------------------------------

const mediaId = () =>
  z
    .number()
    .int()
    .min(1)
    .describe(
      "Numeric media asset id (e.g. 42). Media files are not documents — they have no documentId and no draft/published versions.",
    );

const folderId = () =>
  z
    .number()
    .int()
    .min(1)
    .describe(
      "Numeric media folder id (e.g. 3). Folders are not documents — they use numeric ids.",
    );

const folderName = () =>
  z
    .string()
    .min(1)
    .regex(new RegExp(NO_SLASHES), "Folder name cannot contain slashes.")
    .regex(
      new RegExp(NO_SURROUNDING_SPACE, "s"),
      "Folder name cannot start or end with a whitespace.",
    )
    .describe(
      "Folder name as shown in the Media Library. Cannot contain slashes or start/end with a space, and must be unique among its siblings.",
    );

const parentFolderId = () =>
  folderId()
    .nullable()
    .describe(
      "Numeric id of the containing folder. Pass null for the media library root. Use media_list_folders to discover folder ids.",
    );

const listAssetsInput = () =>
  z.object({
    folderId: folderId()
      .optional()
      .describe(
        "Only return assets directly inside this folder. Omit for every folder; pass null for assets at the media library root.",
      )
      .nullable(),
    mime: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Filter by mime type prefix or exact value (e.g. "image", "image/png", "application/pdf").',
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("Case-insensitive substring search on the asset name."),
    page: z.number().int().min(1).optional().describe("Page number (1-indexed, default: 1)."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Items per page (default: 25, max: 100)."),
    sort: z
      .enum(ALLOWED_SORT_STRINGS)
      .optional()
      .describe(
        `Sort expression. One of: ${ALLOWED_SORT_STRINGS.join(", ")}. Defaults to "createdAt:DESC".`,
      ),
  });

const updateAssetInput = () =>
  z.strictObject({
    id: mediaId(),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "New asset name as shown in the Media Library. Renames the entry only — the stored file and its URL are unchanged.",
      ),
    alternativeText: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Alt text used by the frontend for accessibility. Pass null to clear it; the field then reads back as an empty string.",
      ),
    caption: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Caption shown alongside the asset. Pass null to clear it; the field then reads back as an empty string.",
      ),
  });

const createFolderInput = () =>
  z.strictObject({
    name: folderName(),
    parent: parentFolderId()
      .optional()
      .describe(
        "Numeric id of the parent folder. Omit or pass null to create the folder at the media library root.",
      ),
  });

const renameFolderInput = () => z.strictObject({ id: folderId(), name: folderName() });

const moveFolderInput = () => z.strictObject({ id: folderId(), parent: parentFolderId() });

const deleteFolderInput = () =>
  z.strictObject({
    ids: z
      .array(folderId())
      .min(1)
      .max(100)
      .describe(
        "Numeric ids of the folders to delete (1-100). FOLDER ids only — asset ids are a separate namespace of integers and are rejected here; use media_delete_assets for assets.",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "When true (the default), nothing is deleted and the tool only reports how many folders and files WOULD be removed. Pass false to actually perform the irreversible deletion.",
      ),
  });

const moveAssetsInput = () =>
  z.strictObject({
    ids: z
      .array(mediaId())
      .min(1)
      .max(100)
      .describe(
        "Numeric ids of the assets to move (1-100). ASSET ids only, taken from media_list_assets or media_get_asset — never from media_list_folders. Folder ids are numbered separately and the same number often names both an asset and a folder, so a folder id here moves the asset sharing that number; use media_move_folder to move a folder.",
      ),
    folder: folderId()
      .nullable()
      .describe(
        "Numeric id of the destination folder. Pass null to move the assets to the media library root. Required — including the explicit null — so a move always names a destination. Use media_list_folders to discover folder ids.",
      ),
  });

const deleteAssetsInput = () =>
  z.strictObject({
    ids: z
      .array(mediaId())
      .min(1)
      .max(100)
      .describe(
        "Numeric ids of the assets to delete (1-100). ASSET ids only, taken from media_list_assets or media_get_asset — never from media_list_folders. Folder ids are numbered separately and the same number often names both an asset and a folder, so a folder id here deletes the asset sharing that number; use media_delete_folder for folders.",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "When true (the default), NOTHING is deleted and the tool only reports which assets WOULD be permanently removed. Pass false to actually perform the irreversible deletion.",
      ),
  });

// --- output ------------------------------------------------------------------------------------

const asset = () =>
  z.object({
    id: z.number().describe("Numeric asset id — the canonical identifier for this asset."),
    name: z.string(),
    alternativeText: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    url: z.string().describe("Public (or signed, for private providers) URL of the asset."),
    mime: z.string().describe('Mime type, e.g. "image/png".'),
    size: z.number().describe("File size in kilobytes, as stored by Strapi."),
    width: z.number().nullable().optional().describe("Pixel width, images only."),
    height: z.number().nullable().optional().describe("Pixel height, images only."),
    ext: z
      .string()
      .nullable()
      .optional()
      .describe('File extension including the dot, e.g. ".png".'),
    folder: z
      .object({ id: z.number(), name: z.string() })
      .nullable()
      .optional()
      .describe("Containing folder, or null when the asset sits at the media library root."),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  });

// One instance: the conversion finds the tree's cycle by identity and writes a `$ref`.
const folderNode: z.ZodType = z.lazy(() =>
  z.object({ id: z.number(), name: z.string(), children: z.array(folderNode) }),
);

const folder = () =>
  z.object({
    id: z.number().describe("Numeric folder id — the canonical identifier for this folder."),
    name: z.string(),
    parent: z
      .object({ id: z.number(), name: z.string().optional() })
      .nullable()
      .optional()
      .describe(
        "Containing folder, or null when the folder sits at the media library root. Absent when this response did not load the relation — absent means unknown, not root.",
      ),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  });

const failure = (verb: string, reason: string) =>
  z.object({
    id: z.number().describe(`The requested asset id that was not ${verb}.`),
    reason: z.string().describe(reason),
  });

const OUTPUTS = {
  media_list_assets: () =>
    z.object({
      results: z.array(asset()),
      pagination: z.object({
        page: z.number(),
        pageSize: z.number(),
        pageCount: z.number(),
        total: z.number(),
      }),
    }),
  media_get_asset: () => z.object({ data: asset().nullable() }),
  media_list_folders: () =>
    z.object({ data: z.array(folderNode).describe("Nested folder structure, roots first.") }),
  media_update_asset: () => z.object({ data: asset() }),
  media_move_assets: () =>
    z.object({
      destinationFolder: z
        .object({ id: z.number(), name: z.string().optional() })
        .nullable()
        .describe(
          "The destination folder, or null when the assets were moved to the media library root.",
        ),
      moved: z.array(asset()).describe("The assets that were moved, in their new location."),
      failed: z
        .array(
          failure(
            "moved",
            "Why this id was not moved — a missing asset, or one this token may not edit.",
          ),
        )
        .describe(
          "The ids that were not moved, each with a reason. The moves reported in `moved` still happened — retry only these.",
        ),
    }),
  media_delete_assets: () =>
    z.object({
      dryRun: z
        .boolean()
        .describe(
          "True when this was a preview and NOTHING was deleted. False when the deletion was performed and is irreversible.",
        ),
      deleted: z
        .array(asset())
        .describe(
          "On a dry run, the assets that WOULD be permanently deleted. On a real run, the assets that were deleted — they no longer exist and cannot be read back.",
        ),
      failed: z
        .array(
          failure(
            "deleted",
            "Why this id was not deleted — a missing asset (possibly a folder id), or one this token may not delete.",
          ),
        )
        .describe(
          "The ids that were not deleted, each with a reason. On a real run the deletions reported in `deleted` still happened — retry only these.",
        ),
      totalFileNumber: z
        .number()
        .describe(
          "How many assets are in `deleted` — the count that WOULD be removed on a dry run, or that was removed on a real one.",
        ),
    }),
  media_create_folder: () => z.object({ data: folder() }),
  media_rename_folder: () => z.object({ data: folder() }),
  media_move_folder: () => z.object({ data: folder() }),
  media_delete_folder: () =>
    z.object({
      dryRun: z
        .boolean()
        .describe(
          "True when this was a preview and NOTHING was deleted. False when the deletion was performed.",
        ),
      folders: z
        .array(folder())
        .describe("The folders matched by the given ids (the roots of the cascade)."),
      totalFolderNumber: z
        .number()
        .describe(
          "Total folders affected, including the matched folders themselves and every descendant.",
        ),
      totalFileNumber: z.number().describe("Total files affected, across the whole cascade."),
    }),
} satisfies Record<keyof typeof DESCRIPTIONS, () => z.ZodType>;

// --- the tools ---------------------------------------------------------------------------------

/** What Strapi says instead of Zod for a key the tool refuses, and for a folder name. */
const bulk = (verb: "moves" | "deletes", tool: string, folderTool: string): McpMessages => ({
  keys: [
    {
      keys: ["id", "fileIds"],
      message: `${tool} ${verb} assets in bulk: pass \`ids\` as an array of numeric asset ids, even for a single asset.`,
    },
    {
      keys: ["folderIds"],
      message: `${tool} ${verb} assets only. Use ${folderTool} to ${verb === "moves" ? "move" : "delete"} a folder.`,
    },
  ],
});
const FOLDER_NAME: McpMessages["patterns"] = {
  [NO_SLASHES]: "Folder name cannot contain slashes.",
  [NO_SURROUNDING_SPACE]: "Folder name cannot start or end with a whitespace.",
};

type ToolName = keyof typeof DESCRIPTIONS;

const TOOLS: [ToolName, string, keyof typeof ACTIONS, (() => z.ZodType) | null, McpMessages?][] = [
  ["media_list_assets", "Media: list assets", "read", listAssetsInput],
  ["media_get_asset", "Media: get asset", "read", () => z.object({ id: mediaId() })],
  ["media_list_folders", "Media: list folders", "read", null],
  [
    "media_update_asset",
    "Media: update asset metadata",
    "update",
    updateAssetInput,
    {
      keys: [
        {
          keys: ["folder", "folderId", "folderPath"],
          message:
            "Folder changes are not supported by media_update_asset. Use media_move_assets to move an asset between folders.",
        },
      ],
    },
  ],
  [
    "media_move_assets",
    "Media: move assets between folders",
    "update",
    moveAssetsInput,
    bulk("moves", "media_move_assets", "media_move_folder"),
  ],
  [
    "media_delete_assets",
    "Media: delete assets (destructive)",
    "update",
    deleteAssetsInput,
    bulk("deletes", "media_delete_assets", "media_delete_folder"),
  ],
  [
    "media_create_folder",
    "Media: create folder",
    "create",
    createFolderInput,
    { patterns: FOLDER_NAME },
  ],
  [
    "media_rename_folder",
    "Media: rename folder",
    "update",
    renameFolderInput,
    {
      keys: [
        {
          keys: ["parent"],
          message:
            "media_rename_folder only changes a folder name. Use media_move_folder to change a folder location.",
        },
      ],
      patterns: FOLDER_NAME,
    },
  ],
  [
    "media_move_folder",
    "Media: move folder",
    "update",
    moveFolderInput,
    {
      keys: [
        {
          keys: ["name"],
          message:
            "media_move_folder only changes a folder location. Use media_rename_folder to change a folder name.",
        },
      ],
    },
  ],
  ["media_delete_folder", "Media: delete folder (destructive)", "update", deleteFolderInput],
];

/** A tool without an input schema takes none: the MCP SDK lists an empty object. */
const EMPTY_INPUT = { type: "object", properties: {} };

export const mediaMcpTools = (): McpTool[] =>
  TOOLS.map(([name, title, action, input, messages]) => ({
    name,
    title,
    description: DESCRIPTIONS[name],
    inputSchema: input === null ? EMPTY_INPUT : mcpJsonSchema(input(), "input"),
    outputSchema: mcpJsonSchema(OUTPUTS[name](), "output"),
    policies: [{ action: ACTIONS[action] }],
    localized: false,
    uid: FILE_UID,
    operation: name.slice("media_".length),
    ...(messages === undefined ? {} : { messages }),
  }));
