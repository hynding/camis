import { runtimePhp } from "../../runtime-php";

/**
 * Strapi's upload security (`upload.config.security` in config/plugins): the MIME types an
 * upload may have (`allowedTypes`, patterns such as `image/*`) and the ones it may not
 * (`deniedTypes`). A port of the upload plugin's mime-validation, in its order: a denied declared,
 * extension or detected type refuses the file; otherwise the allow list must match the type the
 * file settles on, which is the detected one when it agrees with the extension, else the
 * extension's, else the declared one. Strapi detects by file signature (file-type), which never
 * names a text format, so a text file is typed by its extension here too.
 */
export const emitStrapiMimeTypes = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiMimeTypes.php", import.meta.url));
