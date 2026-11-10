import { stableJson, type GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { PHP_MARKER } from "../hooks/names";
import { CONTENT_TYPE_BUILDER_PATH, emitContentTypeBuilderRuntime } from "./builder-runtime";
import { CONTENT_TYPE_BUILDER_PAGE_PATH, emitContentTypeBuilderPage } from "./page";
import { CONTENT_TYPE_BUILDER_SCHEMA_PATH, emitContentTypeBuilderSchema } from "./schema-runtime";
import {
  emitSchemaSync,
  emitSchemaSyncCommand,
  SCHEMA_SYNC_COMMAND_PATH,
  SCHEMA_SYNC_PATH,
} from "./schema-sync";

/** The content model the app was built from, which the read-only builder shows. */
export const SCHEMA_COPY_PATH = "resources/camis/schema.json";
export const CONTENT_TYPE_BUILDER_CONFIG_PATH = "config/content-type-builder.php";

// `camis develop` writes both variables into .env; unset, the builder is read-only.
const CONFIG = `<?php
${PHP_MARKER}

declare(strict_types=1);

return [
    // The camis project config (camis.config.json) whose content model the builder edits.
    'project' => env('CAMIS_PROJECT_CONFIG'),

    // The command that rebuilds every target from it, run in the project's directory.
    'build_command' => env('CAMIS_BUILD_COMMAND'),

    // The environments it edits in, as Strapi's builder edits only under "strapi develop".
    'environments' => ['local'],

    // Seconds a build, or the database sync after it, may take.
    'timeout' => (int) env('CAMIS_BUILD_TIMEOUT', 300),
];
`;

/**
 * Strapi's Content-Type Builder: read-only over the model the app was built from, an editor of
 * the project's IR under `camis develop`. `document` is the IR as written, not as normalized.
 */
export const emitContentTypeBuilder = (document: IrDocument, secured: boolean): GeneratedFile[] => [
  { path: SCHEMA_COPY_PATH, content: stableJson(document) },
  { path: CONTENT_TYPE_BUILDER_CONFIG_PATH, content: CONFIG },
  { path: CONTENT_TYPE_BUILDER_PAGE_PATH, content: emitContentTypeBuilderPage(secured) },
  { path: CONTENT_TYPE_BUILDER_PATH, content: emitContentTypeBuilderRuntime() },
  { path: CONTENT_TYPE_BUILDER_SCHEMA_PATH, content: emitContentTypeBuilderSchema() },
  { path: SCHEMA_SYNC_PATH, content: emitSchemaSync() },
  { path: SCHEMA_SYNC_COMMAND_PATH, content: emitSchemaSyncCommand() },
];
