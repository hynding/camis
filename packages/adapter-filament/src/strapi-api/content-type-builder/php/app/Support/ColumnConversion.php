<?php

declare(strict_types=1);

namespace App\Support;

use DateTimeImmutable;
use Throwable;

/**
 * A column's values carried over to another group of types, as the schema sync converts a field the
 * Content-Type Builder changed from text to a number (or any other column type to another): what the
 * new type can hold is kept, the rest emptied. Types are written as the sync records them:
 * "string(255)", "decimal(8, 2)", "bigInteger unsigned".
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

    private const FORMATS = ['date' => 'Y-m-d', 'dateTime' => 'Y-m-d H:i:s', 'time' => 'H:i:s'];

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
            'text' => self::text($value, self::length($to)),
            'integer' => self::integer($value),
            'decimal' => self::decimal($value),
            'boolean' => self::boolean($value),
            'date', 'dateTime', 'time' => self::moment($value, self::FORMATS[self::group($to)]),
            'json' => self::json($value, $source),
            default => $value,
        };
    }

    private static function name(string $type): string
    {
        return (string) preg_replace('/[\s(].*$/', '', $type);
    }

    private static function length(string $type): ?int
    {
        return self::name($type) === 'string' && preg_match('/^string\((\d+)\)/', $type, $match) ? (int) $match[1] : null;
    }

    private static function text(mixed $value, ?int $length): string
    {
        $text = match (true) {
            is_bool($value) => $value ? 'true' : 'false',
            is_scalar($value) => (string) $value,
            default => (string) json_encode($value),
        };

        return $length === null ? $text : mb_substr($text, 0, $length);
    }

    /** Rounded, as SQL's casts round; an integer written out keeps every digit, or is too big to hold. */
    private static function integer(mixed $value): ?int
    {
        if (is_bool($value)) {
            return $value ? 1 : 0;
        }
        if (is_int($value)) {
            return $value;
        }
        $text = trim((string) (is_scalar($value) ? $value : ''));
        if (preg_match('/^-?\d+$/', $text)) {
            $integer = 0 + $text;

            return is_int($integer) ? $integer : null;
        }

        return is_numeric($text) ? (int) round((float) $text) : null;
    }

    private static function decimal(mixed $value): float|null
    {
        if (is_bool($value)) {
            return $value ? 1.0 : 0.0;
        }
        $text = trim((string) (is_scalar($value) ? $value : ''));

        return is_numeric($text) ? (float) $text : null;
    }

    private static function boolean(mixed $value): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value) || is_float($value)) {
            return $value != 0;
        }

        return filter_var(is_scalar($value) ? trim((string) $value) : null, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    }

    private static function moment(mixed $value, string $format): ?string
    {
        if (! is_string($value) || trim($value) === '') {
            return null;
        }
        try {
            return (new DateTimeImmutable(trim($value)))->format($format);
        } catch (Throwable) {
            return null;
        }
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
