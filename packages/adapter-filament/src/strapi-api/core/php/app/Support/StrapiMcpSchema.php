<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Checks a tool's arguments against its JSON Schema the way the MCP server's Zod schema checks
 * them in Strapi: the same issues in the same order, with Zod 4's messages, and the defaults
 * filled in. The schemas are the ones tools/list shows (resources/strapi/mcp.json), so only the
 * keywords Zod writes are read. Two refinements a JSON Schema cannot say are Strapi's own: a sort
 * names one of the fields its description lists, and a relation's `set` stands alone.
 */
final class StrapiMcpSchema
{
    /** @var list<array{path: list<int|string>, message: string, abort: bool}> */
    private array $issues = [];

    /** @param array<string, mixed> $root */
    private function __construct(private readonly array $root)
    {
    }

    /**
     * The arguments with their defaults, or the issues Strapi reports as
     * "<path>: <message>, …".
     *
     * @param  array<string, mixed>  $schema
     * @return array{0: mixed, 1: list<string>}
     */
    public static function validate(array $schema, mixed $value): array
    {
        $validator = new self($schema);
        $value = $validator->check($schema, $value, [], true);

        return [$value, array_map(
            fn (array $issue): string => ($issue['path'] === [] ? '' : implode('.', $issue['path']).': ').$issue['message'],
            $validator->issues,
        )];
    }

    /** @param list<int|string> $path */
    private function check(array $schema, mixed $value, array $path, bool $present): mixed
    {
        if (isset($schema['$ref'])) {
            $schema = $this->resolve((string) $schema['$ref']) + array_diff_key($schema, ['$ref' => true]);
        }
        if (array_key_exists('not', $schema) && $schema['not'] === []) {
            $this->issue($path, 'Invalid input: expected never, received '.self::received($value, $present));

            return $value;
        }
        if (isset($schema['anyOf'])) {
            return $this->union($schema['anyOf'], $value, $path, $present);
        }
        if (isset($schema['oneOf'])) {
            return $this->discriminated($schema['oneOf'], $value, $path, $present);
        }
        if (array_key_exists('const', $schema)) {
            if ($value !== $schema['const']) {
                $this->issue($path, 'Invalid input: expected '.json_encode($schema['const']));
            }

            return $value;
        }
        if (isset($schema['enum'])) {
            return $this->enum($schema['enum'], $value, $path);
        }

        return match ($schema['type'] ?? null) {
            'object' => $this->object($schema, $value, $path, $present),
            'array' => $this->array($schema, $value, $path, $present),
            'string' => $this->string($schema, $value, $path, $present),
            'number', 'integer' => $this->number($schema, $value, $path, $present),
            'boolean' => is_bool($value) ? $value : $this->typed($path, 'boolean', $value, $present),
            'null' => $value === null && $present ? null : $this->typed($path, 'null', $value, $present),
            default => $value,
        };
    }

    /** @param list<int|string> $path */
    private function object(array $schema, mixed $value, array $path, bool $present): mixed
    {
        if (! is_array($value) || ($value !== [] && array_is_list($value)) || ! $present) {
            return $this->typed($path, 'object', $value, $present);
        }
        $required = $schema['required'] ?? [];
        $properties = $schema['properties'] ?? [];
        $before = count($this->issues);
        foreach ($properties as $key => $property) {
            $key = (string) $key;
            if (array_key_exists($key, $value)) {
                $value[$key] = $this->check($property, $value[$key], [...$path, $key], true);
            } elseif (array_key_exists('default', $property)) {
                $value[$key] = $property['default'];
            } elseif (in_array($key, $required, true)) {
                $this->check($property, null, [...$path, $key], false);
            }
        }
        if (($schema['additionalProperties'] ?? null) === false) {
            $unknown = array_values(array_diff(array_map('strval', array_keys($value)), array_map('strval', array_keys($properties))));
            if ($unknown !== []) {
                $keys = implode(', ', array_map(fn (string $k): string => json_encode($k), $unknown));
                $this->issue($path, (count($unknown) === 1 ? 'Unrecognized key: ' : 'Unrecognized keys: ').$keys);
            }
        }
        if (! $this->abortedSince($before) && self::isRelationEdit($properties) && array_key_exists('set', $value)
            && (array_key_exists('connect', $value) || array_key_exists('disconnect', $value))) {
            $this->issue([...$path, 'set'], 'set is mutually exclusive with connect and disconnect', false);
        }

        return $value;
    }

    /** @param list<int|string> $path */
    private function array(array $schema, mixed $value, array $path, bool $present): mixed
    {
        if (! is_array($value) || ! array_is_list($value) || ! $present) {
            return $this->typed($path, 'array', $value, $present);
        }
        foreach ($value as $i => $item) {
            $value[$i] = $this->check($schema['items'] ?? [], $item, [...$path, $i], true);
        }
        if (isset($schema['minItems']) && count($value) < $schema['minItems']) {
            $this->issue($path, "Too small: expected array to have >={$schema['minItems']} items", false);
        }
        if (isset($schema['maxItems']) && count($value) > $schema['maxItems']) {
            $this->issue($path, "Too big: expected array to have <={$schema['maxItems']} items", false);
        }

        return $value;
    }

    /** @param list<int|string> $path */
    private function string(array $schema, mixed $value, array $path, bool $present): mixed
    {
        if (! is_string($value) || ! $present) {
            return $this->typed($path, 'string', $value, $present);
        }
        $length = mb_strlen($value);
        if (isset($schema['minLength']) && $length < $schema['minLength']) {
            $this->issue($path, "Too small: expected string to have >={$schema['minLength']} characters", false);
        }
        if (isset($schema['maxLength']) && $length > $schema['maxLength']) {
            $this->issue($path, "Too big: expected string to have <={$schema['maxLength']} characters", false);
        }
        if (($schema['format'] ?? null) === 'email' && isset($schema['pattern']) && preg_match('/'.$schema['pattern'].'/u', $value) !== 1) {
            $this->issue($path, 'Invalid email address', false);
        }
        $this->sortField($path, $value);

        return $value;
    }

    /** @param list<int|string> $path */
    private function number(array $schema, mixed $value, array $path, bool $present): mixed
    {
        if (! (is_int($value) || is_float($value)) || ! $present) {
            return $this->typed($path, 'number', $value, $present);
        }
        if (($schema['type'] ?? null) === 'integer' && (is_float($value) && floor($value) !== $value)) {
            $this->issue($path, 'Invalid input: expected int, received number');

            return $value;
        }
        if (isset($schema['minimum']) && $value < $schema['minimum']) {
            $this->issue($path, 'Too small: expected number to be >='.self::number_($schema['minimum']), false);
        }
        if (isset($schema['maximum']) && $value > $schema['maximum'] && $schema['maximum'] !== 9007199254740991) {
            $this->issue($path, 'Too big: expected number to be <='.self::number_($schema['maximum']), false);
        }

        return $value;
    }

    /** @param list<int|string> $path */
    private function enum(array $values, mixed $value, array $path): mixed
    {
        if (! in_array($value, $values, true)) {
            $this->issue($path, count($values) === 1
                ? 'Invalid input: expected '.json_encode($values[0])
                : 'Invalid option: expected one of '.implode('|', array_map(fn ($v): string => (string) json_encode($v), $values)));
        }

        return $value;
    }

    /**
     * Zod's union: the first option that takes the value; else the issues of the one option the
     * value got past the type of, when there is just one; else "Invalid input".
     *
     * @param  list<array<string, mixed>>  $options
     * @param  list<int|string>  $path
     */
    private function union(array $options, mixed $value, array $path, bool $present): mixed
    {
        $outcomes = [];
        foreach ($options as $option) {
            $validator = new self($this->root);
            $checked = $validator->check($option, $value, $path, $present);
            if ($validator->issues === []) {
                return $checked;
            }
            $outcomes[] = $validator->issues;
        }
        $kept = array_values(array_filter($outcomes, fn (array $issues): bool => array_filter($issues, fn (array $i): bool => $i['abort']) === []));
        if (count($kept) === 1) {
            array_push($this->issues, ...$kept[0]);
        } else {
            $this->issue($path, 'Invalid input');
        }

        return $value;
    }

    /**
     * @param  list<array<string, mixed>>  $options
     * @param  list<int|string>  $path
     */
    private function discriminated(array $options, mixed $value, array $path, bool $present): mixed
    {
        if (! is_array($value) || ! $present) {
            return $this->typed($path, 'object', $value, $present);
        }
        foreach ($options as $option) {
            if (($option['properties']['type']['const'] ?? null) === ($value['type'] ?? null)) {
                return $this->check($option, $value, $path, true);
            }
        }
        $this->issue([...$path, 'type'], 'Invalid input');

        return $value;
    }

    /** A sort expression's field is one of those its description lists (Strapi's refinement). */
    private function sortField(array $path, string $value): void
    {
        if (($path[0] ?? null) !== 'sort' || count($path) > 2 || preg_match('/^([^:]+):(asc|desc)$/', $value, $match) !== 1) {
            return;
        }
        $description = (string) ($this->root['properties']['sort']['description'] ?? '');
        if (preg_match('/Valid fields: (.*)\.$/', $description, $fields) !== 1) {
            return;
        }
        $names = explode(', ', $fields[1]);
        if (! in_array($match[1], $names, true)) {
            $this->issue($path, 'Sort field must be one of: '.implode(', ', $names), false);
        }
    }

    /** @param array<string, mixed> $properties */
    private static function isRelationEdit(array $properties): bool
    {
        return array_keys($properties) === ['connect', 'disconnect', 'set'];
    }

    /** @param list<int|string> $path */
    private function typed(array $path, string $expected, mixed $value, bool $present): mixed
    {
        $this->issue($path, "Invalid input: expected {$expected}, received ".self::received($value, $present));

        return $value;
    }

    /** @param list<int|string> $path */
    private function issue(array $path, string $message, bool $abort = true): void
    {
        $this->issues[] = ['path' => $path, 'message' => $message, 'abort' => $abort];
    }

    private function abortedSince(int $from): bool
    {
        foreach (array_slice($this->issues, $from) as $issue) {
            if ($issue['abort']) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string, mixed> */
    private function resolve(string $ref): array
    {
        if ($ref === '#') {
            return $this->root;
        }
        $name = substr($ref, strlen('#/$defs/'));

        return $this->root['$defs'][$name] ?? [];
    }

    private static function received(mixed $value, bool $present): string
    {
        return match (true) {
            ! $present => 'undefined',
            $value === null => 'null',
            is_bool($value) => 'boolean',
            is_int($value), is_float($value) => 'number',
            is_string($value) => 'string',
            is_array($value) && array_is_list($value) && $value !== [] => 'array',
            default => 'object',
        };
    }

    private static function number_(int|float $n): string
    {
        return is_float($n) && floor($n) === $n ? (string) (int) $n : (string) $n;
    }
}
