import { runtimePhp } from "../runtime-php";

/**
 * Strapi's data import, restore strategy: an archive `strapi export` wrote (`.tar`, `.tar.gz`,
 * `.tar.gz.enc`)
 * replaces this app's content, files and configuration. Everything `StrapiTransferMap` names is
 * deleted, then every archived entry is inserted with its documentId and timestamps, then its
 * links, then the files' bytes. Ids are this database's own: links are resolved through the map
 * of archived id → new row id the inserts build. A row of a type without draft and publish keeps
 * its links to a draft-and-publish document's draft only, as camis stores them. Users are matched by email
 * rather than deleted, since the same table holds the admin's accounts. The canonical check is
 * `transfer/read-vectors.json`, recorded from strapi-php after it imported the same archive.
 */
export const emitStrapiImport = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiImport.php", import.meta.url));
