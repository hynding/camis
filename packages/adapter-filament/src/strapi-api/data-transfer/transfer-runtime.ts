import { runtimePhp } from "../../runtime-php";

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
export const emitStrapiImport = (decimals = false): string => {
  const php = runtimePhp(new URL("./php/app/Support/StrapiImport.php", import.meta.url));
  return decimals ? withDecimalDigits(php) : php;
};

// Each archived value written to a column, and the import's last method, which the helper follows.
const DECIMAL_DIGITS_WRITES: [string, string][] = [
  [
    "$row[$attribute['column']] = self::value($value, $attribute['type'], $model->getDateFormat());",
    "$row[$attribute['column']] = self::digits(self::value($value, $attribute['type'], $model->getDateFormat()), $attribute, \"{$model->getTable()}.{$attribute['column']}\");",
  ],
  [
    "$row[$scalar['column']] = self::value(is_array($value) ? self::at($value, $scalar['key']) : null, $scalar['type'], $model->getDateFormat());",
    "$row[$scalar['column']] = self::digits(self::value(is_array($value) ? self::at($value, $scalar['key']) : null, $scalar['type'], $model->getDateFormat()), $scalar, \"{$model->getTable()}.{$scalar['column']}\");",
  ],
  [
    "$row[$scalar['column']] = self::value(self::at($item, $scalar['key']), $scalar['type'], $relation->getRelated()->getDateFormat());",
    "$row[$scalar['column']] = self::digits(self::value(self::at($item, $scalar['key']), $scalar['type'], $relation->getRelated()->getDateFormat()), $scalar, \"{$relation->getRelated()->getTable()}.{$scalar['column']}\");",
  ],
  [
    "    /** Whether this project holds the type, as the transfer map's per-project types say. */",
    `    /**
     * A decimal stating its digits (the transfer map's \`digits\`) as its column keeps it, as every
     * write through DecimalDigits keeps it; a value that is not a decimal that fits stops the
     * import, as any value its column cannot take does.
     *
     * @param array<string, mixed> $attribute
     */
    private static function digits(mixed $value, array $attribute, string $column): mixed
    {
        if ($value === null || ! isset($attribute['digits'])) {
            return $value;
        }
        [$precision, $scale] = $attribute['digits'];

        return DecimalDigits::canonical($value, $precision, $scale)
            ?? throw new \\RuntimeException("{$column} takes a decimal of at most {$precision} digits, {$scale} of them after the point, not " . var_export($value, true));
    }

    /** Whether this project holds the type, as the transfer map's per-project types say. */`,
  ],
];

/**
 * The import for a project with decimals stating their digits: SQLite keeps one beyond a PHP float
 * as text, which takes any string, so an archived value is written as every other write keeps it.
 */
export const withDecimalDigits = (php: string): string =>
  DECIMAL_DIGITS_WRITES.reduce((patched, [from, to]) => {
    if (patched.split(from).length !== 2) {
      throw new Error(`StrapiImport.php must hold exactly one "${from}"`);
    }
    return patched.replace(from, () => to);
  }, php);
