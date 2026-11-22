import { runtimePhp } from "../../runtime-php";

/** A backtick, which yup's messages quote values in. */
/**
 * Strapi 5's entity validator over a write's data (validation-vectors.json and
 * constraint-vectors.json, recorded from strapi-php): yup's casts, its messages and Strapi's
 * per-type rules. Every failing field is reported, in attribute order, as Strapi's
 * ValidationError: one error's message, or "N errors occurred", with each error's path, message
 * and value under details.errors. A draft skips required, minLength, regex, min and unique, as
 * Strapi's does.
 *
 * $rules is a controller's `RULES`: wire key → Strapi attribute (type, required, minLength,
 * maxLength, min, max, regex, enum, default), a component's `fields`, a dynamic zone's
 * `components`. A unique attribute names where its value is stored (`unique`: a column, and the
 * relation holding its items' rows), and $unique gives the other entries' rows to look in. A
 * required relation or file (`toOne` when one target replaces another) must keep one while
 * camis.documents.strict_relations is on, as Strapi's api.documents.strictRelations.
 */
export const emitStrapiValidator = (uniqueDigits = false): string => {
  const php = runtimePhp(new URL("./php/app/Support/StrapiValidator.php", import.meta.url));
  return uniqueDigits ? withUniqueDigits(php) : php;
};

// A unique decimal stating its digits (its `unique` carrying `digits`) is looked up by the value as
// sent, not yup's cast (a float, which keeps 14 digits), and compared as it is stored.
const UNIQUE_DIGITS_CHECKS: [string, string][] = [
  [
    "&& self::taken($cast, $rule['unique'], $repeated, $context['unique'])",
    "&& self::taken(isset($rule['unique']['digits']) ? $value : $cast, $rule['unique'], $repeated, $context['unique'])",
  ],
  [
    `        $query = $others();
        if (isset($stored['relation'])) {`,
    `        $query = $others();
        if (isset($stored['digits'])) {
            return self::takenDigits($query, $stored, $value);
        }
        if (isset($stored['relation'])) {`,
  ],
  [
    `        return $query->where($stored['column'], $value)->exists();
    }
`,
    `        return $query->where($stored['column'], $value)->exists();
    }

    /**
     * Whether another entry holds a decimal stating its digits, compared as it is stored: rounded
     * to its scale, which is what its unique index compares, and bound exactly on every database
     * (DecimalDigits::where). A value its column cannot hold is left to the write, which refuses it.
     *
     * @param  array{column: string, relation?: string, digits: array{int, int}}  $stored
     */
    private static function takenDigits(Builder $query, array $stored, mixed $value): bool
    {
        [$precision, $scale] = $stored['digits'];
        $canonical = DecimalDigits::canonical($value, $precision, $scale);
        if ($canonical === null) {
            return false;
        }
        $matching = fn (Builder $rows): bool => DecimalDigits::where($rows, $stored['column'], '$eq', $canonical, $precision, $scale);
        if (isset($stored['relation'])) {
            return $query->whereHas($stored['relation'], fn (Builder $items) => $matching($items))->exists();
        }

        return $matching($query) && $query->exists();
    }
`,
  ],
];

/**
 * The validator for a project with a unique decimal stating its digits: SQLite keeps one beyond a
 * PHP float as text, and every database keeps it rounded to its scale, so the value as sent (1.5
 * beside a stored 1.50000, or 1.500004) found no other entry and reached the unique index.
 */
export const withUniqueDigits = (php: string): string =>
  UNIQUE_DIGITS_CHECKS.reduce((patched, [from, to]) => patched.replace(from, () => to), php);
