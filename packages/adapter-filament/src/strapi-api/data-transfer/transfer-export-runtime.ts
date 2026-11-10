import { runtimePhp } from "../../runtime-php";

/**
 * Strapi's data export: the archive `strapi export` writes (`.tar`, `.tar.gz`, `.tar.gz.enc`),
 * read back from this app's tables through `StrapiTransferMap`, so Strapi (or strapi-php, or
 * camis) can import it. Every entry keeps its documentId, timestamps, components, draft and
 * published versions and locale; links are written from the side that declares them, as Strapi
 * lists them. A type without draft and publish links a draft-and-publish document through its
 * draft only here; Strapi links both versions, so the published twin is linked too. Roles carry
 * Strapi's default users-permissions actions plus the IR's grants (`StrapiTransferMap::ACTIONS`).
 * Schemas are Strapi's own for this IR (`resources/strapi/schemas.jsonl`), since Strapi's import
 * compares them to its own strictly. The canonical check is the boot job's round trip: an import
 * of strapi-php's archive, exported again, holds the same data.
 */
export const emitStrapiExport = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiExport.php", import.meta.url));
