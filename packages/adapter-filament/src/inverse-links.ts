import type { GeneratedFile } from "@camis/adapter-kernel";
import { runtimePhp } from "./runtime-php";

export const INVERSE_LINKS_PATH = "app/Support/InverseLinks.php";

/** The admin's writer for a relation picked on its side that holds no key, when some type has one. */
export const emitInverseLinks = (needed: boolean): GeneratedFile[] =>
  needed
    ? [
        {
          path: INVERSE_LINKS_PATH,
          content: runtimePhp(
            new URL(`./strapi-api/core/php/${INVERSE_LINKS_PATH}`, import.meta.url),
          ),
        },
      ]
    : [];
