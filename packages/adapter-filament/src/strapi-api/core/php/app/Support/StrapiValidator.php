<?php

declare(strict_types=1);

namespace App\Support;

use Closure;
use Illuminate\Database\Eloquent\Builder;

final class StrapiValidator
{
    private const STRINGS = ['string', 'text', 'richtext', 'password', 'email', 'uid', 'enumeration'];

    private const NUMBERS = ['integer', 'float', 'decimal'];

    private const LINKS = ['relation', 'media'];

    /** yup's email, as Strapi's string().email() checks it. */
    private const EMAIL = '/^[a-zA-Z0-9.!#$%&\'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/';

    /** A uid without a regex of its own holds only these. */
    private const UID = '^[A-Za-z0-9-_.~]*$';

    /** The protocols a blocks link may use, a relative link being https. */
    private const LINK_PROTOCOLS = ['http', 'https', 'ftp', 'mailto', 'tel'];

    /**
     * Strapi's create and update: the request's data checked against $rules, or a ValidationError.
     * $given holds the values the route supplies (an upsert's key), which the data need not.
     *
     * @param  (Closure(): Builder)|null  $unique  the other entries' rows, a unique value must not be among
     */
    public static function validate(mixed $data, array $rules, bool $creating, bool $draft = false, array $given = [], ?Closure $unique = null): void
    {
        if (! is_array($data) || ($data !== [] && array_is_list($data))) {
            throw StrapiError::validation('Missing "data" payload in the request body');
        }
        $data = array_replace($data, $given);
        $context = [
            'creating' => $creating,
            'draft' => $draft,
            'unique' => $unique,
            'strict' => (bool) config('camis.documents.strict_relations', true),
        ];
        $errors = [];
        self::object($data, $rules, [], $context, null, $errors);
        if ($errors !== []) {
            $message = count($errors) > 1 ? count($errors) . ' errors occurred' : $errors[0]['message'];
            throw StrapiError::validation($message, ['errors' => $errors]);
        }
    }

    /**
     * $siblings holds the items a unique value must be the only one of (a repeatable on the entry,
     * or a dynamic zone's items of one component) and the path to these fields within an item.
     *
     * @param  array{items: list<mixed>, within: list<string>}|null  $siblings
     */
    private static function object(array $data, array $rules, array $path, array $context, ?array $siblings, array &$errors): void
    {
        foreach ($rules as $key => $rule) {
            $at = [...$path, (string) $key];
            if (in_array($rule['type'], self::LINKS, true)) {
                self::link($data, (string) $key, $rule, $at, $context, $errors);
                continue;
            }
            // A creation takes a field's default for a value it does not send.
            $sent = array_key_exists($key, $data) || ($context['creating'] && array_key_exists('default', $rule));
            if (! $sent) {
                if ($context['creating'] && ! $context['draft'] && ($rule['required'] ?? false)) {
                    $errors[] = self::error($at, '{path} must be defined.');
                }
                continue;
            }
            $value = array_key_exists($key, $data) ? $data[$key] : $rule['default'];
            match ($rule['type']) {
                'component' => self::component($value, $rule, $at, $context, $siblings, $errors),
                'dynamiczone' => self::zone($value, $rule, $at, $context, $errors),
                default => self::scalar($value, $rule, $at, $context, self::shared($siblings, (string) $key), $errors),
            };
        }
    }

    /** Strapi's strictRelations: a required relation or file a write leaves empty. */
    private static function link(array $data, string $key, array $rule, array $path, array $context, array &$errors): void
    {
        if (! $context['strict'] || $context['draft'] || ! ($rule['required'] ?? false)) {
            return;
        }
        $given = array_key_exists($key, $data);
        $value = $given ? $data[$key] : null;
        if (! self::emptied($context['creating'], $given, $value, $rule['toOne'] ?? false)) {
            return;
        }
        // The message names the attribute alone, not its path, as Strapi's does.
        $errors[] = $given
            ? self::failure($path, "{$key} must be defined.", self::linkValue($value))
            : self::failure($path, "{$key} must be defined.");
    }

    /**
     * Whether a write leaves a required link empty: a creation must connect one; an update keeps
     * its own unless it empties them, and a to-one link loses its target to a disconnect alone.
     */
    private static function emptied(bool $creating, bool $given, mixed $value, bool $toOne): bool
    {
        if (! $given) {
            return $creating;
        }
        if (self::disconnectOnly($value)) {
            return $creating || $toOne;
        }
        if (! $creating && is_array($value) && ! array_is_list($value) && ! isset($value['set'])
            && ($value['connect'] ?? null) === []) {
            return false;
        }

        return ! self::linksOne($value);
    }

    /** A bare id, a list of ids, or a connect or set holding at least one. */
    private static function linksOne(mixed $value): bool
    {
        if ($value === null) {
            return false;
        }
        if (! is_array($value)) {
            return true;
        }
        if (array_is_list($value)) {
            return $value !== [];
        }
        foreach (['connect', 'set'] as $verb) {
            if (($value[$verb] ?? null) !== null) {
                return ! is_array($value[$verb]) || ! array_is_list($value[$verb]) || $value[$verb] !== [];
            }
        }

        return true;
    }

    private static function disconnectOnly(mixed $value): bool
    {
        if (! is_array($value) || array_is_list($value) || isset($value['set'])) {
            return false;
        }
        $connect = $value['connect'] ?? null;
        if ($connect !== null && (! is_array($connect) || ! array_is_list($connect) || $connect !== [])) {
            return false;
        }
        $disconnect = $value['disconnect'] ?? null;

        return $disconnect !== null && (! is_array($disconnect) || ! array_is_list($disconnect) || $disconnect !== []);
    }

    /** A link as Strapi reports it: a list is a set, and each id an object holding it. */
    private static function linkValue(mixed $value): mixed
    {
        if (! is_array($value)) {
            return $value;
        }
        if (array_is_list($value)) {
            return ['set' => array_map(self::linkTarget(...), $value)];
        }
        foreach (['connect', 'disconnect', 'set'] as $verb) {
            if (is_array($value[$verb] ?? null) && array_is_list($value[$verb])) {
                $value[$verb] = array_map(self::linkTarget(...), $value[$verb]);
            }
        }

        return $value;
    }

    private static function linkTarget(mixed $target): mixed
    {
        return is_int($target) ? ['id' => $target] : $target;
    }

    /** @param  array{items: list<mixed>, within: list<string>}|null  $siblings */
    private static function component(mixed $value, array $rule, array $path, array $context, ?array $siblings, array &$errors): void
    {
        if (! ($rule['repeatable'] ?? false)) {
            if ($value === null) {
                return;
            }
            if (! is_array($value) || ($value !== [] && array_is_list($value))) {
                $errors[] = self::notType($path, 'object', $value);

                return;
            }
            $within = $siblings === null ? null : ['items' => $siblings['items'], 'within' => [...$siblings['within'], (string) end($path)]];
            self::object($value, $rule['fields'], $path, $context, $within, $errors);

            return;
        }
        if (! is_array($value) || ! array_is_list($value)) {
            $errors[] = self::notType($path, 'array', $value);

            return;
        }
        // Strapi compares the items of a repeatable on the entry itself, not of one deeper down.
        $siblings = count($path) === 1 ? ['items' => $value, 'within' => []] : null;
        foreach ($value as $i => $item) {
            if (! is_array($item) || ($item !== [] && array_is_list($item))) {
                $errors[] = self::notType([...$path, (string) $i], 'object', $item);
                continue;
            }
            self::object($item, $rule['fields'], [...$path, (string) $i], $context, $siblings, $errors);
        }
    }

    /**
     * The values more than one of the siblings holds at a field, which none of them may hold.
     *
     * @param  array{items: list<mixed>, within: list<string>}|null  $siblings
     * @return list<mixed>
     */
    private static function shared(?array $siblings, string $key): array
    {
        if ($siblings === null) {
            return [];
        }
        $seen = [];
        foreach ($siblings['items'] as $item) {
            foreach ([...$siblings['within'], $key] as $step) {
                $item = is_array($item) && array_key_exists($step, $item) ? $item[$step] : null;
            }
            if ($item !== null) {
                $seen[] = $item;
            }
        }

        return array_values(array_filter($seen, fn (mixed $v): bool => count(array_keys($seen, $v, true)) > 1));
    }

    /**
     * A zone's items by their component; one naming a component the zone lacks is StrapiZones' to
     * refuse or drop. A unique value is compared with the zone's other items of its component.
     */
    private static function zone(mixed $value, array $rule, array $path, array $context, array &$errors): void
    {
        $items = is_array($value) && array_is_list($value) ? $value : [];
        foreach ($items as $i => $item) {
            $uid = is_array($item) ? ($item['__component'] ?? '') : '';
            $fields = $rule['components'][$uid] ?? null;
            if ($fields === null) {
                continue;
            }
            $same = array_values(array_filter($items, fn (mixed $other): bool => is_array($other) && ($other['__component'] ?? null) === $uid));
            self::object($item, $fields, [...$path, (string) $i], $context, ['items' => $same, 'within' => []], $errors);
        }
    }

    private static function scalar(mixed $value, array $rule, array $path, array $context, array $repeated, array &$errors): void
    {
        $type = $rule['type'];
        $draft = $context['draft'];
        if ($value === null) {
            if ($draft || ! ($rule['required'] ?? false)) {
                return;
            }
            $schema = match (true) {
                in_array($type, self::STRINGS, true) => 'string',
                in_array($type, self::NUMBERS, true) => 'number',
                $type === 'boolean' => 'boolean',
                default => null,
            };
            $errors[] = $schema === null ? self::error($path, '{path} cannot be null.', null) : self::notType($path, $schema, null);

            return;
        }
        // Strapi's unique check, made once a value passes its type: an empty one is no value.
        $unique = fn (mixed $cast): array => isset($rule['unique']) && ! $draft && $cast !== ''
            && self::taken($cast, $rule['unique'], $repeated, $context['unique'])
            ? [self::failure($path, 'This attribute must be unique', $cast)]
            : [];
        array_push($errors, ...match (true) {
            in_array($type, self::STRINGS, true) => self::string($value, $rule, $path, $draft, $unique),
            in_array($type, self::NUMBERS, true) => self::number($value, $rule, $path, $draft, $unique),
            $type === 'biginteger' => self::bigInteger($value, $path, $unique),
            $type === 'boolean' => self::boolean($value, $path),
            $type === 'blocks' => self::blocks($value, $path),
            in_array($type, ['date', 'time', 'datetime', 'timestamp'], true) => $unique($value),
            default => [],
        });
    }

    /** Whether another of the repeatable's items, or another entry, already holds a unique value. */
    private static function taken(mixed $value, array $stored, array $repeated, ?Closure $others): bool
    {
        if (in_array($value, $repeated, true)) {
            return true;
        }
        if ($others === null) {
            return false;
        }
        $query = $others();
        if (isset($stored['relation'])) {
            return $query->whereHas($stored['relation'], fn (Builder $items) => $items->where($stored['column'], $value))->exists();
        }

        return $query->where($stored['column'], $value)->exists();
    }

    /** @param  Closure(mixed): array  $unique */
    private static function string(mixed $value, array $rule, array $path, bool $draft, Closure $unique): array
    {
        if (! is_string($value)) {
            return [self::notType($path, 'string', $value)];
        }
        $type = $rule['type'];
        if ($type === 'enumeration') {
            return in_array($value, $rule['enum'], true)
                ? []
                : [self::error($path, '{path} must be one of the following values: ' . implode(', ', [...$rule['enum'], '']), $value)];
        }
        $found = [];
        $length = mb_strlen($value);
        if (! $draft && ($rule['minLength'] ?? 0) > 0 && $length < $rule['minLength']) {
            $found[] = self::error($path, "{path} must be at least {$rule['minLength']} characters", $value);
        }
        $max = $rule['maxLength'] ?? ($type === 'string' ? 255 : 0);
        if ($max > 0 && $length > $max) {
            $found[] = self::error($path, "{path} must be at most {$max} characters", $value);
        }
        // An optional field's empty string is no value, which its regex does not apply to.
        $optionalEmpty = $value === '' && ! ($rule['required'] ?? false);
        if (! $draft && isset($rule['regex']) && ! $optionalEmpty && ! self::matches($rule['regex'], $value)) {
            $found[] = self::mismatch($path, $rule['regex'], $value);
        }
        // Strapi's email and uid add their checks to a string's, unique included.
        array_push($found, ...$unique($value));
        if (! $draft && $type === 'email') {
            if ($value !== '' && preg_match(self::EMAIL, $value) !== 1) {
                $found[] = self::error($path, '{path} must be a valid email', $value);
            }
            if ($value === '') {
                $found[] = self::error($path, '{path} cannot be empty', $value);
            }
        }
        if (! $draft && $type === 'uid' && ! self::matches($rule['regex'] ?? self::UID, $value)) {
            $found[] = self::mismatch($path, $rule['regex'] ?? self::UID, $value);
        }

        return $found;
    }

    /**
     * yup's number: a numeric string is cast, anything else that is not a number is NaN.
     *
     * @param  Closure(mixed): array  $unique
     */
    private static function number(mixed $value, array $rule, array $path, bool $draft, Closure $unique): array
    {
        $cast = $value;
        if (is_string($value)) {
            $stripped = preg_replace('/\s/u', '', $value) ?? '';
            $cast = is_numeric($stripped) ? $stripped + 0 : NAN;
        } elseif (! is_int($value) && ! is_float($value)) {
            $cast = NAN;
        }
        if (is_float($cast) && is_nan($cast)) {
            return [self::notType($path, 'number', $cast, $value)];
        }
        $found = [];
        $whole = ! is_float($cast) || floor($cast) === $cast;
        if ($rule['type'] === 'integer' && ! $whole) {
            $found[] = self::error($path, '{path} must be an integer', $cast);
        }
        $finite = is_finite((float) $cast);
        if ($rule['type'] !== 'integer' && ! $finite) {
            $found[] = self::error($path, '{path} must be a finite number', $cast);
        }
        if (! $draft && isset($rule['min']) && $cast < $rule['min']) {
            $found[] = self::error($path, '{path} must be greater than or equal to ' . self::print($rule['min']), $cast);
        }
        if (isset($rule['max']) && $cast > $rule['max']) {
            $found[] = self::error($path, '{path} must be less than or equal to ' . self::print($rule['max']), $cast);
        }
        // A number Strapi's type checks refuse is left to them, not looked up.
        if ($finite && ($rule['type'] !== 'integer' || $whole)) {
            array_push($found, ...$unique($cast));
        }

        return $found;
    }

    /** @param  Closure(mixed): array  $unique */
    private static function bigInteger(mixed $value, array $path, Closure $unique): array
    {
        $valid = is_int($value)
            || (is_float($value) && is_finite($value) && floor($value) === $value)
            || (is_string($value) && preg_match('/^[+-]?\d+$/', trim($value)) === 1);

        return $valid ? $unique($value) : [self::error($path, '{path} must be a valid integer', $value)];
    }

    /** yup's boolean: true and 1, false and 0, as words or numbers, are cast. */
    private static function boolean(mixed $value, array $path): array
    {
        $cast = is_bool($value) || (is_scalar($value) && preg_match('/^(true|1|false|0)$/i', (string) $value) === 1);

        return $cast ? [] : [self::notType($path, 'boolean', $value)];
    }

    /**
     * Strapi's blocks validator: each node of the document tree against the schema its type names.
     * Anything but a list is cast to null, as yup's array does, which an optional field takes.
     */
    private static function blocks(mixed $value, array $path): array
    {
        $found = [];
        if (is_array($value) && array_is_list($value)) {
            self::node($value, true, ['array', 'of' => ['lazy', 'block']], $path, $found);
        }

        return $found;
    }

    /** A blocks node's yup schema by name. */
    private static function schema(string $name): array
    {
        $inline = fn (string $node): array => ['array', 'of' => ['lazy', 'inline'], 'required' => true, 'min' => "{$node} node children must have at least one Text or Link node"];
        $string = ['string', 'required' => true];
        $optional = ['string', 'nullable' => true];
        $number = ['number', 'required' => true];

        return match ($name) {
            'paragraph', 'heading', 'quote', 'list', 'image', 'code' => ['object', 'fields' => [
                'type' => ['string', 'required' => true, 'oneOf' => [$name]],
                ...match ($name) {
                    'paragraph' => ['children' => $inline('Paragraph')],
                    'heading' => ['level' => ['number', 'required' => true, 'oneOf' => [1, 2, 3, 4, 5, 6]], 'children' => $inline('Heading')],
                    'quote' => ['children' => $inline('Quote')],
                    'code' => ['language' => $optional, 'children' => ['array', 'of' => ['schema', 'text'], 'required' => true, 'min' => 'Quote node children must have at least one Text or Link node']],
                    'list' => [
                        'format' => ['string', 'required' => true, 'oneOf' => ['ordered', 'unordered']],
                        'children' => ['array', 'of' => ['lazy', 'listChild'], 'required' => true, 'min' => 'List node children must have at least one ListItem or ListNode'],
                    ],
                    'image' => [
                        'image' => ['object', 'fields' => [
                            'name' => $string, 'alternativeText' => $optional, 'url' => $string, 'caption' => $optional,
                            'width' => $number, 'height' => $number, 'formats' => ['object', 'nullable' => true, 'fields' => []],
                            'hash' => $string, 'ext' => $string, 'mime' => $string, 'size' => $number, 'previewUrl' => $optional,
                            'provider' => $string, 'provider_metadata' => ['mixed'], 'createdAt' => $string, 'updatedAt' => $string,
                        ]],
                        'children' => ['array', 'of' => ['lazy', 'inline'], 'required' => true],
                    ],
                },
            ]],
            'list-item' => ['object', 'fields' => [
                'type' => ['string', 'required' => true, 'oneOf' => ['list-item']],
                'children' => ['array', 'of' => ['lazy', 'inline'], 'required' => true],
            ]],
            'text' => ['object', 'fields' => [
                'type' => ['string', 'required' => true, 'oneOf' => ['text']],
                'text' => ['string', 'test' => 'Text must be defined with at least an empty string'],
                'bold' => ['boolean'], 'italic' => ['boolean'], 'underline' => ['boolean'], 'strikethrough' => ['boolean'], 'code' => ['boolean'],
            ]],
            'link' => ['object', 'fields' => [
                'type' => ['string', 'required' => true, 'oneOf' => ['link']],
                'url' => ['string', 'test' => 'Please specify a valid link.', 'link' => true],
                'children' => ['array', 'of' => ['schema', 'text'], 'required' => true],
            ]],
        };
    }

    /** Which node types a place in the tree takes, and Strapi's message for any other. */
    private const LAZY = [
        'block' => [['paragraph', 'heading', 'quote', 'list', 'image', 'code'], 'Block node is of invalid type'],
        'inline' => [['text', 'link'], 'Inline node must be Text or Link'],
        'listChild' => [['list', 'list-item'], 'Inline node must be list-item or list'],
    ];

    /**
     * One value against a yup schema, as yup checks it: a missing value ($given false) only
     * against required and its tests, a value of the wrong type only against its type.
     */
    private static function node(mixed $value, bool $given, array $schema, array $path, array &$found): void
    {
        if ($schema[0] === 'schema') {
            self::node($value, $given, self::schema($schema[1]), $path, $found);

            return;
        }
        if ($schema[0] === 'lazy') {
            [$types, $message] = self::LAZY[$schema[1]];
            $type = is_array($value) ? ($value['type'] ?? null) : null;
            if (in_array($type, $types, true)) {
                self::node($value, $given, self::schema($type), $path, $found);
            } else {
                $found[] = self::failure($path, $message, $value);
            }

            return;
        }
        if ($schema[0] === 'mixed') {
            return;
        }
        if (! $given && $schema[0] !== 'object') {
            if ($schema['required'] ?? false) {
                $found[] = self::error($path, '{path} is a required field');
            } elseif (isset($schema['test'])) {
                $found[] = self::failure($path, $schema['test']);
            }

            return;
        }
        if ($value === null && $given) {
            if (! ($schema['nullable'] ?? false)) {
                $found[] = self::notType($path, $schema[0], null);
            }

            return;
        }
        match ($schema[0]) {
            'string' => self::textNode($value, $schema, $path, $found),
            'number' => self::numberNode($value, $schema, $path, $found),
            'boolean' => array_push($found, ...self::boolean($value, $path)),
            'object' => self::objectNode($given ? $value : [], $schema, $path, $found),
            'array' => self::arrayNode($value, $schema, $path, $found),
        };
    }

    private static function textNode(mixed $value, array $schema, array $path, array &$found): void
    {
        if (is_array($value)) {
            $found[] = self::notType($path, 'string', $value);

            return;
        }
        // yup's string casts any other scalar to its text.
        $text = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
        if (isset($schema['oneOf']) && ! in_array($text, $schema['oneOf'], true)) {
            $found[] = self::error($path, '{path} must be one of the following values: ' . implode(', ', $schema['oneOf']), $text);
        }
        if (($schema['link'] ?? false) && ! self::safeLink($text)) {
            $found[] = self::failure($path, $schema['test'], $text);
        }
    }

    private static function numberNode(mixed $value, array $schema, array $path, array &$found): void
    {
        $cast = is_int($value) || is_float($value) ? $value : (is_string($value) && is_numeric(trim($value)) ? trim($value) + 0 : NAN);
        if (is_float($cast) && is_nan($cast)) {
            $found[] = self::notType($path, 'number', $cast, $value);

            return;
        }
        if (isset($schema['oneOf']) && ! in_array($cast, $schema['oneOf'], false)) {
            $found[] = self::error($path, '{path} must be one of the following values: ' . implode(', ', $schema['oneOf']), $cast);
        }
    }

    private static function objectNode(mixed $value, array $schema, array $path, array &$found): void
    {
        if (! is_array($value) || ($value !== [] && array_is_list($value))) {
            $found[] = self::notType($path, 'object', $value);

            return;
        }
        foreach ($schema['fields'] as $key => $field) {
            self::node($value[$key] ?? null, array_key_exists($key, $value), $field, [...$path, $key], $found);
        }
    }

    /** yup's array: a string holding a JSON list is read as one, anything else not a list is null. */
    private static function arrayNode(mixed $value, array $schema, array $path, array &$found): void
    {
        $list = is_string($value) ? json_decode($value, true) : $value;
        if (! is_array($list) || ! array_is_list($list)) {
            $found[] = self::notType($path, 'array', null, $value);

            return;
        }
        foreach ($list as $i => $item) {
            self::node($item, true, $schema['of'], [...$path, (string) $i], $found);
        }
        if (isset($schema['min']) && $list === []) {
            $found[] = self::failure($path, $schema['min'], $list);
        }
    }

    /** Strapi's checkValidLink: an allowed protocol, a link starting with / being on the site. */
    private static function safeLink(string $link): bool
    {
        $scheme = parse_url(str_starts_with($link, '/') ? "https://strapi.io{$link}" : $link, PHP_URL_SCHEME);

        return is_string($scheme) && in_array(strtolower($scheme), self::LINK_PROTOCOLS, true);
    }

    /** A Strapi regex is a JavaScript pattern's source; its slashes are escaped as RegExp prints them. */
    private static function source(string $regex): string
    {
        return preg_replace('#(?<!\\\\)/#', '\\/', $regex) ?? $regex;
    }

    private static function matches(string $regex, string $value): bool
    {
        return preg_match('/' . self::source($regex) . '/u', $value) === 1;
    }

    private static function mismatch(array $path, string $regex, string $value): array
    {
        return self::error($path, '{path} must match the following: "/' . self::source($regex) . '/"', $value);
    }

    private static function notType(array $path, string $type, mixed $value, mixed $original = null): array
    {
        $cast = $original !== null && $original !== $value
            ? ' (cast from the value `' . self::print($original, true) . '`).'
            : '.';

        return self::error($path, "{path} must be a `{$type}` type, but the final value was: `" . self::print($value, true) . '`' . $cast, $value);
    }

    /** One of Strapi's details.errors whose message starts with the field's path. */
    private static function error(array $path, string $message, mixed ...$value): array
    {
        return self::failure($path, self::label($path) . substr($message, strlen('{path}')), ...$value);
    }

    /** One of Strapi's details.errors; a value left out was not sent, as yup leaves it undefined. */
    private static function failure(array $path, string $message, mixed ...$value): array
    {
        $error = ['path' => $path, 'message' => $message, 'name' => 'ValidationError'];

        return $value === [] ? $error : $error + ['value' => $value[0]];
    }

    /** yup's path: ['lines', '0', 'label'] reads lines[0].label. */
    private static function label(array $path): string
    {
        $label = '';
        foreach ($path as $segment) {
            $label .= ctype_digit($segment) ? "[{$segment}]" : ($label === '' ? $segment : ".{$segment}");
        }

        return $label;
    }

    /** yup's printValue. */
    private static function print(mixed $value, bool $quoteStrings = false): string
    {
        return match (true) {
            $value === null => 'null',
            is_bool($value) => $value ? 'true' : 'false',
            is_float($value) && is_nan($value) => 'NaN',
            is_float($value) && floor($value) === $value && abs($value) < 1e21 => (string) (int) $value,
            is_int($value), is_float($value) => (string) $value,
            is_string($value) => $quoteStrings ? "\"{$value}\"" : $value,
            default => (string) json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        };
    }
}
