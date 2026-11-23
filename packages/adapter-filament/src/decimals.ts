import type { GeneratedFile, StorageLayout } from "@camis/adapter-kernel";
import { DOUBLE_DIGITS, decimalDigits, decimalsBeyond, digitsBeyond } from "@camis/ir-core";
import type { CapabilityGap, ComponentFieldT, Field, IrDocument } from "@camis/ir-schema";
import { runtimePhp } from "./runtime-php";

/**
 * The significant digits PHP writes a float with when it becomes a string (its `precision`
 * setting, 14): PDO SQLite reads a decimal column's value as a float, and Laravel's decimal cast
 * makes a string of it, so a decimal of 15 digits read back through a float loses its last one.
 */
export const PHP_FLOAT_DIGITS = 14;

/**
 * Whether a decimal states more digits than a PHP float carries to its string: such a decimal is
 * text on SQLite, answered as a string and taken as exact digits, never through a float.
 */
export const beyondPhpFloat = (field: Field | ComponentFieldT): boolean =>
  digitsBeyond(field, PHP_FLOAT_DIGITS);

/**
 * What a decimal beyond a PHP float loses where the app compares or stores it. On the Laravel
 * storage layout its column is text on SQLite (see `decimalColumn`), so the Strapi API style's
 * ordering filters and sorts compare it as text there, while its equality filters compare the
 * canonical digits every write through Eloquent or the import keeps (DecimalDigits), and the
 * admin list's number filters (Filament's NumberConstraint) compare it through a float; the
 * Laravel API style neither filters nor sorts. Its archives carry a decimal as a number, as Strapi's do, for Strapi to import. On
 * Strapi's storage layout the column is the one Strapi made, which SQLite keeps as a double.
 */
export const filamentDecimalGaps = (
  doc: IrDocument,
  apiStyle: "laravel" | "strapi",
  storage: StorageLayout,
): CapabilityGap[] =>
  storage === "laravel" && apiStyle === "laravel"
    ? []
    : decimalsBeyond(doc, PHP_FLOAT_DIGITS).map(({ location, digits }) => ({
        feature: "decimalPrecision",
        location,
        severity: "downgrade",
        message:
          storage === "strapi"
            ? `"${location.field}" keeps ${digits.precision} digits, but on Strapi's storage layout its column is Strapi's, which SQLite keeps as a double that PHP reads back as a float: on SQLite only ${PHP_FLOAT_DIGITS} significant digits are kept`
            : `"${location.field}" keeps its ${digits.precision} digits as text on SQLite, where a filter on it finds equal values exactly but compares text, not numbers, in an ordering comparison ($lt, $lte, $gt, $gte, $between) or a sort; a JSON number sent for it is read as a double first, so an exact value is sent as a string; the admin list's number filters compare it through a PHP float, as text on SQLite; a data-transfer archive carries it as a number, as Strapi's archives do, rounded to ${DOUBLE_DIGITS} significant digits`,
      }));

const DECIMAL_DIGITS_RUNTIME = [
  "app/Casts/DecimalDigitsCast.php",
  "app/Rules/DecimalDigitsRule.php",
  "app/Support/DecimalDigits.php",
];

const UNIQUE_RULE = "app/Rules/DecimalDigitsUniqueRule.php";

/** How a form checks a unique decimal stating its digits (see `uniqueRule` in fields.ts). */
const UNIQUE_RULE_USE = "new \\App\\Rules\\DecimalDigitsUniqueRule(";

/**
 * What writes a decimal stating its digits, through Eloquent (DecimalDigitsCast) and the admin's
 * form (DecimalDigitsRule) on either API style, and what the Strapi API style
 * filters one by: emitted only for a project with such a decimal. The form's uniqueness rule
 * (DecimalDigitsUniqueRule) comes only with a form among `emitted` that checks it: a form whose
 * rows share their values (draft and publish, locales) leaves a unique field's rule out.
 */
export const decimalDigitsFiles = (
  doc: IrDocument,
  emitted: readonly GeneratedFile[],
): GeneratedFile[] => {
  const fields = [...doc.contentTypes, ...doc.components].flatMap((holder) =>
    holder.fields.filter((field) => decimalDigits(field) !== undefined),
  );
  const paths = [
    ...(fields.length > 0 ? DECIMAL_DIGITS_RUNTIME : []),
    ...(emitted.some((file) => file.content.includes(UNIQUE_RULE_USE)) ? [UNIQUE_RULE] : []),
  ];
  return paths.map((path) => ({
    path,
    content: runtimePhp(new URL(`./php/${path}`, import.meta.url)),
  }));
};
