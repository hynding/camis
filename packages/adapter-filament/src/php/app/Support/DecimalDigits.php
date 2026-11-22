<?php

declare(strict_types=1);

namespace App\Support;

use Brick\Math\BigDecimal;
use Brick\Math\Exception\MathException;
use Brick\Math\RoundingMode;
use Illuminate\Database\Query\Expression;
use Illuminate\Support\Facades\DB;

/**
 * A decimal stating its digits as every database keeps it: rounded half away from zero to its
 * scale, as MySQL's DECIMAL and PostgreSQL's NUMERIC round what they store, and written with exactly
 * the scale's digits after the point, with no exponent and no sign or zero it does not need. SQLite
 * keeps a decimal beyond a PHP float as text, which compares as written, so this one form is what
 * lets a filter or a unique index there see 1.5 and 1.50 as one value.
 */
final class DecimalDigits
{
    /**
     * A written value as its column keeps it, or null when it is not a decimal or has more digits
     * before the point than the column keeps. A JSON number is taken as its shortest digits.
     */
    public static function canonical(mixed $value, int $precision, int $scale): ?string
    {
        $decimal = self::parse($value)?->toScale($scale, RoundingMode::HALF_UP);
        if ($decimal === null || strlen((string) $decimal->getUnscaledValue()->abs()) > $precision) {
            return null;
        }

        return (string) $decimal;
    }

    /**
     * A filter's value as the column is compared with it: its form at the scale, bound as text on
     * SQLite, where the column is text or gives text its numeric affinity, and written as a numeric
     * literal elsewhere, because MySQL compares a DECIMAL with a string as two doubles. A value that
     * is not a decimal is left as it is.
     */
    public static function filter(mixed $value, int $scale): mixed
    {
        $decimal = self::parse($value)?->toScale($scale, RoundingMode::HALF_UP);
        if ($decimal === null) {
            return $value;
        }

        // The literal is BigDecimal's own digits, a sign and a point: nothing else reaches the SQL.
        return DB::connection()->getDriverName() === 'sqlite' ? (string) $decimal : new Expression((string) $decimal);
    }

    private static function parse(mixed $value): ?BigDecimal
    {
        $digits = match (true) {
            // PHP writes a float with 14 digits; var_export writes the shortest that read back as it.
            is_float($value) && is_finite($value) => var_export($value, true),
            is_int($value) => (string) $value,
            is_string($value) => trim($value),
            default => null,
        };
        if ($digits === null) {
            return null;
        }
        try {
            return BigDecimal::of($digits);
        } catch (MathException) {
            return null;
        }
    }
}
