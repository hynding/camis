import { runtimePhp } from "../runtime-php";

export const CONTENT_TYPE_BUILDER_SCHEMA_PATH = "app/Support/ContentTypeBuilderSchema.php";

/**
 * The Content-Type Builder's edits of the content model and roles, as pure PHP functions of their
 * decoded JSON.
 */
export const emitContentTypeBuilderSchema = (): string =>
  runtimePhp(
    new URL(
      `../strapi-api/content-type-builder/php/${CONTENT_TYPE_BUILDER_SCHEMA_PATH}`,
      import.meta.url,
    ),
  );
