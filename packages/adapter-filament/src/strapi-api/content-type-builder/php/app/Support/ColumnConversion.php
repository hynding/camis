<?php

declare(strict_types=1);

namespace App\Support;

use DateTimeImmutable;
use DateTimeZone;

/**
 * A column's values carried over to another group of types, as the schema sync converts a field the
 * Content-Type Builder changed from text to a number (or any other column type to another): what the
 * new column can hold is kept, the rest emptied, so no value the database would refuse reaches it.
 * Types are written as the sync records them: "string(255)", "decimal(8, 2)", "integer unsigned",
 * "enum(draft|published)".
 */
final class ColumnConversion
{
    /** Laravel's column types by the group a database converts within; one not listed is its own. */
    private const GROUPS = [
        'text' => ['string', 'char', 'text', 'tinyText', 'mediumText', 'longText', 'enum'],
        'integer' => ['integer', 'bigInteger', 'smallInteger', 'tinyInteger', 'mediumInteger'],
        'decimal' => ['decimal', 'float', 'double'],
        'boolean' => ['boolean'],
        'date' => ['date'],
        'dateTime' => ['dateTime', 'dateTimeTz', 'timestamp', 'timestampTz'],
        'time' => ['time', 'timeTz'],
        'json' => ['json', 'jsonb'],
    ];

    /** Each integer type's bits, which bound what it holds, signed or not. */
    private const INTEGER_BITS = ['tinyInteger' => 8, 'smallInteger' => 16, 'mediumInteger' => 24, 'integer' => 32, 'bigInteger' => 64];

    private const FORMATS = ['date' => 'Y-m-d', 'dateTime' => 'Y-m-d H:i:s', 'time' => 'H:i:s'];

    /**
     * The ways a date or a time is written that are read as one: ISO 8601 and SQL's, no more, since
     * PHP's free-form parsing takes "2024" for a time of day and "a" for a time zone.
     */
    private const DATE_FORMATS = [
        'Y-m-d\TH:i:s.uP', 'Y-m-d\TH:i:sP', 'Y-m-d\TH:i:s.u', 'Y-m-d\TH:i:s', 'Y-m-d\TH:i',
        'Y-m-d H:i:s.uP', 'Y-m-d H:i:sP', 'Y-m-d H:i:s.u', 'Y-m-d H:i:s', 'Y-m-d H:i', 'Y-m-d',
    ];

    private const TIME_FORMATS = ['H:i:s.u', 'H:i:s', 'H:i'];

    /** The plain text types by what they hold, MySQL's TINYTEXT to LONGTEXT. */
    private const TEXT_SIZES = ['tinyText' => 1, 'text' => 2, 'mediumText' => 3, 'longText' => 4];

    /**
     * What a change between two plain text types is on a driver: null when either is not one, 'same'
     * where the database keeps text of every size in one type (SQLite, PostgreSQL), else 'widen' or
     * 'narrow'. A narrower column would cut the values it holds, so the sync never makes one.
     */
    public static function sizeChange(string $driver, string $before, string $declared): ?string
    {
        $from = self::TEXT_SIZES[$before] ?? null;
        $to = self::TEXT_SIZES[$declared] ?? null;
        if ($from === null || $to === null) {
            return null;
        }
        if (! in_array($driver, ['mysql', 'mariadb'], true) || $from === $to) {
            return 'same';
        }

        return $to > $from ? 'widen' : 'narrow';
    }

    /**
     * A live column's text size by the name the database gives its type (information_schema's
     * DATA_TYPE, which Schema::getColumnType answers on MySQL and MariaDB), as the sync records it;
     * null for a column that is not a plain text.
     */
    public static function textSizeOf(string $liveType): ?string
    {
        return ['tinytext' => 'tinyText', 'text' => 'text', 'mediumtext' => 'mediumText', 'longtext' => 'longText'][strtolower($liveType)] ?? null;
    }

    /** The group a recorded column type belongs to: a change within one is the database's to make. */
    public static function group(string $type): string
    {
        $name = self::name($type);
        foreach (self::GROUPS as $group => $names) {
            if (in_array($name, $names, true)) {
                return $group;
            }
        }

        return $name;
    }

    /** A value of a column of type $from as a value of type $to, or null where $to cannot hold it. */
    public static function convert(mixed $value, string $from, string $to): mixed
    {
        if ($value === null) {
            return null;
        }
        $source = self::group($from);
        if ($source === 'boolean') {
            $value = in_array($value, [true, 1, '1', 't', 'true'], true);
        }

        return match (self::group($to)) {
            'text' => self::text($value, $to),
            'integer' => self::integer($value, $to),
            'decimal' => self::decimal($value, $to),
            'boolean' => self::boolean($value),
            'date', 'time' => self::moment($value, self::group($to)),
            'dateTime' => self::moment($value, 'dateTime'),
            'json' => self::json($value, $source),
            default => $value,
        };
    }

    private static function name(string $type): string
    {
        return (string) preg_replace('/[\s(].*$/', '', $type);
    }

    /** @return list<string> what the type's parentheses hold: its sizes, or an enum's values */
    private static function parameters(string $type): array
    {
        if (! preg_match('/\((.*)\)/', $type, $match)) {
            return [];
        }

        return str_contains($match[1], '|') || self::name($type) === 'enum'
            ? explode('|', $match[1])
            : array_map('trim', explode(',', $match[1]));
    }

    private static function text(mixed $value, string $type): ?string
    {
        $text = match (true) {
            is_bool($value) => $value ? 'true' : 'false',
            is_scalar($value) => (string) $value,
            default => (string) json_encode($value),
        };
        if (self::name($type) === 'enum') {
            return in_array($text, self::parameters($type), true) ? $text : null;
        }
        $length = in_array(self::name($type), ['string', 'char'], true) ? (int) (self::parameters($type)[0] ?? 0) : 0;

        return $length > 0 ? mb_substr($text, 0, $length) : $text;
    }

    /** Rounded, as SQL's casts round; emptied when the column's type cannot hold it. */
    private static function integer(mixed $value, string $type): ?int
    {
        if (is_bool($value)) {
            return $value ? 1 : 0;
        }
        $text = is_int($value) ? (string) $value : trim(is_scalar($value) ? (string) $value : '');
        if (! is_numeric($text)) {
            return null;
        }
        if (preg_match('/^[+-]?\d+$/', $text)) {
            $integer = 0 + $text;
        } else {
            $rounded = round((float) $text);
            // PHP_INT_MAX as a float is 2^63, one past the largest integer.
            $integer = $rounded >= PHP_INT_MIN && $rounded < PHP_INT_MAX ? (int) $rounded : null;
        }
        if (! is_int($integer)) {
            return null;
        }
        $bits = self::INTEGER_BITS[self::name($type)] ?? 64;
        $unsigned = str_contains($type, 'unsigned');
        if ($unsigned && $integer < 0) {
            return null;
        }
        if ($bits < 64) {
            [$min, $max] = $unsigned ? [0, 2 ** $bits - 1] : [-(2 ** ($bits - 1)), 2 ** ($bits - 1) - 1];
            if ($integer < $min || $integer > $max) {
                return null;
            }
        }

        return $integer;
    }

    /** A decimal rounded to its places, and emptied when its digits do not fit. */
    private static function decimal(mixed $value, string $type): float|null
    {
        if (is_bool($value)) {
            return $value ? 1.0 : 0.0;
        }
        $text = trim(is_scalar($value) ? (string) $value : '');
        if (! is_numeric($text) || ! is_finite((float) $text)) {
            return null;
        }
        $number = (float) $text;
        $sizes = self::parameters($type);
        if (self::name($type) === 'decimal' && count($sizes) === 2) {
            [$total, $places] = [(int) $sizes[0], (int) $sizes[1]];
            $number = round($number, $places);
            if (abs($number) >= 10 ** ($total - $places)) {
                return null;
            }
        }
        if (str_contains($type, 'unsigned') && $number < 0) {
            return null;
        }

        return $number;
    }

    /** True and false as text or a number reads them; anything else, or nothing, is emptied. */
    private static function boolean(mixed $value): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }
        $text = trim(is_scalar($value) ? (string) $value : '');
        if ($text === '') {
            return null;
        }
        if (is_numeric($text)) {
            return (float) $text != 0;
        }

        return filter_var($text, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    }

    /** A date, a date and time, or a time, read only as ISO 8601 or SQL write one; in UTC when it carries an offset. */
    private static function moment(mixed $value, string $group): ?string
    {
        if (! is_string($value) || trim($value) === '') {
            return null;
        }
        $formats = $group === 'time' ? [...self::DATE_FORMATS, ...self::TIME_FORMATS] : self::DATE_FORMATS;
        foreach ($formats as $format) {
            $moment = DateTimeImmutable::createFromFormat('!'.$format, trim($value));
            $errors = DateTimeImmutable::getLastErrors();
            if ($moment !== false && ($errors === false || ($errors['warning_count'] === 0 && $errors['error_count'] === 0))) {
                if (str_contains($format, 'P')) {
                    $moment = $moment->setTimezone(new DateTimeZone('UTC'));
                }

                return $moment->format(self::FORMATS[$group]);
            }
        }

        return null;
    }

    /** JSON text as it is, anything else as the JSON value it reads as. */
    private static function json(mixed $value, string $source): string
    {
        if (is_string($value) && json_validate($value)) {
            return $value;
        }
        if (is_string($value) && in_array($source, ['integer', 'decimal'], true) && is_numeric($value)) {
            return (string) json_encode(0 + $value);
        }

        return (string) json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
}
