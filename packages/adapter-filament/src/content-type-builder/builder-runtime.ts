import { runtimePhp } from "../runtime-php";

export const CONTENT_TYPE_BUILDER_PATH = "app/Support/ContentTypeBuilder.php";

/** The builder's runtime: reads the project's IR and roles, applies an edit, rebuilds and syncs. */
export const emitContentTypeBuilderRuntime = (): string =>
  runtimePhp(
    new URL(`../strapi-api/content-type-builder/php/${CONTENT_TYPE_BUILDER_PATH}`, import.meta.url),
  );
