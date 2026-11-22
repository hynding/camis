<?php

declare(strict_types=1);

namespace App\Support;

use Brick\Math\BigDecimal;
use Brick\Math\Exception\MathException;
use Brick\Math\RoundingMode;
use Illuminate\Database\Eloquent\Builder;

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
     * What is read as a decimal: ASCII digits with at most one point, an optional sign and an
     * exponent of at most three digits, in at most MAX_LENGTH characters. brick/math writes out
     * every zero an exponent stands for, so an unbounded one ("1e100000000") would exhaust memory.
     */
    private const PATTERN = '/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/D';

    private const MAX_LENGTH = 100;

    /** The filter operators compared here; the others are the caller's. */
    private const OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$notIn', '$between'];

    private const COMPARISONS = ['$eq' => '=', '$ne' => '<>', '$gt' => '>', '$gte' => '>=', '$lt' => '<', '$lte' => '<='];

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

    /** Why a value is refused, in Laravel's validation message form. */
    public static function refusal(string $attribute, int $precision, int $scale): string
    {
        return "The {$attribute} field must be a decimal of at most {$precision} digits, {$scale} of them after the point.";
    }

    /**
     * Filters $column by a comparison, exactly and never rounding the filter's value: every value
     * the column holds is a multiple of 10^-scale below 10^(precision - scale) in magnitude, so a
     * value between two of them, or beyond them all, is compared through the nearest one or decides
     * the comparison alone, and what is bound always fits the column. It is bound typed, as DECIMAL
     * on MySQL (which compares a DECIMAL with a string as two doubles) and NUMERIC on PostgreSQL;
     * SQLite compares it with the column's text, or gives it a numeric column's affinity. False,
     * adding nothing, for another operator or a value that is not a decimal, which the caller binds
     * as it came, as it does every other number field's.
     */
    public static function where(Builder $query, string $column, string $operator, mixed $value, int $precision, int $scale): bool
    {
        if (! in_array($operator, self::OPERATORS, true)) {
            return false;
        }
        $listed = in_array($operator, ['$in', '$notIn', '$between'], true);
        $decimals = [];
        foreach ($listed && is_array($value) ? array_values($value) : [$value] as $item) {
            $decimal = self::parse($item);
            if ($decimal === null) {
                return false;
            }
            $decimals[] = $decimal;
        }
        $target = [
            'wrapped' => $query->getQuery()->getGrammar()->wrap($column),
            'bound' => match ($query->getConnection()->getDriverName()) {
                'sqlite' => '?',
                'pgsql' => 'CAST(? AS NUMERIC)',
                default => "CAST(? AS DECIMAL({$precision}, {$scale}))",
            },
            'scale' => $scale,
            // The largest value the column holds; its negation is the smallest.
            'largest' => BigDecimal::ten()->power($precision - $scale)->minus(BigDecimal::ofUnscaledValue(1, $scale)),
        ];

        if ($operator === '$between') {
            if (count($decimals) !== 2) {
                return false;
            }
            $query->where(function (Builder $q) use ($decimals, $target): void {
                self::compare($q, $target, '$gte', $decimals[0]);
                self::compare($q, $target, '$lte', $decimals[1]);
            });

            return true;
        }
        if ($listed) {
            // A value the column cannot hold equals none of its values.
            $held = array_values(array_filter($decimals, fn (BigDecimal $d) => self::holds($target, $d)));
            if ($held === []) {
                self::decided($query, $target, $operator === '$notIn');

                return true;
            }
            $not = $operator === '$notIn' ? ' NOT' : '';
            $placeholders = implode(', ', array_fill(0, count($held), $target['bound']));
            $query->whereRaw(
                "{$target['wrapped']}{$not} IN ({$placeholders})",
                array_map(fn (BigDecimal $d) => (string) $d->toScale($target['scale']), $held),
            );

            return true;
        }
        self::compare($query, $target, $operator, $decimals[0]);

        return true;
    }

    /**
     * One comparison of the column with $decimal, decided alone where the column cannot hold it.
     *
     * @param array{wrapped: string, bound: string, scale: int, largest: BigDecimal} $column
     */
    private static function compare(Builder $query, array $column, string $operator, BigDecimal $decimal): void
    {
        if (self::holds($column, $decimal)) {
            $query->whereRaw("{$column['wrapped']} " . self::COMPARISONS[$operator] . " {$column['bound']}", [(string) $decimal->toScale($column['scale'])]);

            return;
        }
        // Above $decimal is at or above its ceiling at the scale; below it, at or below its floor.
        $nearest = $decimal->toScale($column['scale'], in_array($operator, ['$gt', '$gte'], true) ? RoundingMode::CEILING : RoundingMode::FLOOR);
        $largest = $column['largest'];
        $every = match ($operator) {
            '$eq' => false,
            '$ne' => true,
            '$gt', '$gte' => $nearest->isGreaterThan($largest) ? false : ($nearest->isLessThan($largest->negated()) ? true : null),
            '$lt', '$lte' => $nearest->isLessThan($largest->negated()) ? false : ($nearest->isGreaterThan($largest) ? true : null),
        };
        if ($every !== null) {
            self::decided($query, $column, $every);

            return;
        }
        $comparison = in_array($operator, ['$gt', '$gte'], true) ? '>=' : '<=';
        $query->whereRaw("{$column['wrapped']} {$comparison} {$column['bound']}", [(string) $nearest]);
    }

    /**
     * A comparison decided without the filter's value, matching every value the column holds or
     * none, yet unknown for a row without one as SQL's own comparison is, so $not still leaves
     * that row out.
     *
     * @param array{wrapped: string} $column
     */
    private static function decided(Builder $query, array $column, bool $every): void
    {
        $query->whereRaw($every ? "{$column['wrapped']} = {$column['wrapped']}" : "{$column['wrapped']} <> {$column['wrapped']}");
    }

    /**
     * Whether the column can hold $decimal exactly: no digit beyond its scale, and within its range.
     *
     * @param array{scale: int, largest: BigDecimal} $column
     */
    private static function holds(array $column, BigDecimal $decimal): bool
    {
        return $decimal->stripTrailingZeros()->getScale() <= $column['scale'] && $decimal->abs()->isLessThanOrEqualTo($column['largest']);
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
        if ($digits === null || strlen($digits) > self::MAX_LENGTH || preg_match(self::PATTERN, $digits) !== 1) {
            return null;
        }
        try {
            return BigDecimal::of($digits);
        } catch (MathException) {
            return null;
        }
    }
}
