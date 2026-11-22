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

// Each archived value written to a column, as DecimalDigits::archived keeps a decimal stating its digits.
const DECIMAL_DIGITS_WRITES: [string, string][] = [
  [
    "$row[$attribute['column']] = self::value($value, $attribute['type'], $model->getDateFormat());",
    "$row[$attribute['column']] = DecimalDigits::archived(self::value($value, $attribute['type'], $model->getDateFormat()), $attribute, \"{$model->getTable()}.{$attribute['column']}\");",
  ],
  [
    "$row[$scalar['column']] = self::value(is_array($value) ? self::at($value, $scalar['key']) : null, $scalar['type'], $model->getDateFormat());",
    "$row[$scalar['column']] = DecimalDigits::archived(self::value(is_array($value) ? self::at($value, $scalar['key']) : null, $scalar['type'], $model->getDateFormat()), $scalar, \"{$model->getTable()}.{$scalar['column']}\");",
  ],
  [
    "$row[$scalar['column']] = self::value(self::at($item, $scalar['key']), $scalar['type'], $relation->getRelated()->getDateFormat());",
    "$row[$scalar['column']] = DecimalDigits::archived(self::value(self::at($item, $scalar['key']), $scalar['type'], $relation->getRelated()->getDateFormat()), $scalar, \"{$relation->getRelated()->getTable()}.{$scalar['column']}\");",
  ],
];

/**
 * The import for a project with decimals stating their digits: SQLite keeps one beyond a PHP float
 * as text, which takes any string, so an archived value is written as every other write keeps it.
 * Each write is patched at its anchor, which must occur exactly once.
 */
export const withDecimalDigits = (php: string): string =>
  DECIMAL_DIGITS_WRITES.reduce((patched, [from, to]) => {
    if (patched.split(from).length !== 2) {
      throw new Error(`StrapiImport.php must hold exactly one "${from}"`);
    }
    return patched.replace(from, () => to);
  }, php);
