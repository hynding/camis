import { PHP_RUNTIME } from "@camis/expr-php-emit";

/**
 * The conformance-tested Ring1 class, namespaced for the generated app's PSR-4 autoload.
 * PHP_RUNTIME starts with "<?php\ndeclare(strict_types=1);\n\nfinal class Ring1 {...". Strip the
 * opening tag AND the existing declare (it must not be duplicated), then re-emit with a namespace.
 */
export const emitRing1File = (): string => {
  const classBody = PHP_RUNTIME.replace(/^<\?php\ndeclare\(strict_types=1\);\n\n/, "").trimStart();
  return `<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n\n${classBody}`;
};
