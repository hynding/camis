import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PHP_MARKER } from "./hooks/names";

const OPENING_TAG = "<?php\n";

/**
 * A runtime PHP file the generator copies as it is. The source lives as a real `.php` file so
 * PHPStan and an editor see it as PHP; the generated marker is added on the way out, because the
 * source is hand-written and only the copy belongs to the generator.
 */
export const runtimePhp = (source: URL): string => {
  const php = readFileSync(source, "utf8");
  if (!php.startsWith(OPENING_TAG)) {
    throw new Error(`${fileURLToPath(source)} must start with "<?php" on a line of its own`);
  }
  return `${OPENING_TAG}${PHP_MARKER}\n${php.slice(OPENING_TAG.length)}`;
};
