import { PHP_MARKER } from "../hooks/names";

/** A backtick, which yup's messages quote values in. */
const TICK = "`";

const header = `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n`;

/**
 * Strapi 5's entity validator over a write's data (validation-vectors.json, recorded from
 * strapi-php): yup's casts, its messages and Strapi's per-type rules. Every failing field is
 * reported, in attribute order, as Strapi's ValidationError: one error's message, or "N errors
 * occurred", with each error's path, message and value under details.errors. A draft skips
 * required, minLength, regex and min, as Strapi's does. Relations, media and blocks are left to
 * the code that writes them.
 *
 * $rules is a controller's `RULES`: wire key → Strapi attribute (type, required, minLength,
 * maxLength, min, max, regex, enum, default), a component's `fields`, a dynamic zone's `components`.
 */
export const emitStrapiValidator = (): string =>
  header +
  String.raw`
final class StrapiValidator
{
    private const STRINGS = ['string', 'text', 'richtext', 'password', 'email', 'uid', 'enumeration'];

    private const NUMBERS = ['integer', 'float', 'decimal'];

    /** yup's email, as Strapi's string().email() checks it. */
    private const EMAIL = '/^[a-zA-Z0-9.!#$%&\'*+\/=?^_${TICK}{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/';

    /** A uid without a regex of its own holds only these. */
    private const UID = '^[A-Za-z0-9-_.~]*$';

    /**
     * Strapi's create and update: the request's data checked against $rules, or a ValidationError.
     * $given holds the values the route supplies (an upsert's key), which the data need not.
     */
    public static function validate(mixed $data, array $rules, bool $creating, bool $draft = false, array $given = []): void
    {
        if (! is_array($data) || ($data !== [] && array_is_list($data))) {
            throw StrapiError::validation('Missing "data" payload in the request body');
        }
        $data = array_replace($data, $given);
        $errors = [];
        self::object($data, $rules, [], $creating, $draft, $errors);
        if ($errors !== []) {
            $message = count($errors) > 1 ? count($errors) . ' errors occurred' : $errors[0]['message'];
            throw StrapiError::validation($message, ['errors' => $errors]);
        }
    }

    private static function object(array $data, array $rules, array $path, bool $creating, bool $draft, array &$errors): void
    {
        foreach ($rules as $key => $rule) {
            $at = [...$path, (string) $key];
            // A creation takes a field's default for a value it does not send.
            $sent = array_key_exists($key, $data) || ($creating && array_key_exists('default', $rule));
            if (! $sent) {
                if ($creating && ! $draft && ($rule['required'] ?? false)) {
                    $errors[] = self::error($at, '{path} must be defined.');
                }
                continue;
            }
            $value = array_key_exists($key, $data) ? $data[$key] : $rule['default'];
            match ($rule['type']) {
                'component' => self::component($value, $rule, $at, $creating, $draft, $errors),
                'dynamiczone' => self::zone($value, $rule, $at, $creating, $draft, $errors),
                default => self::scalar($value, $rule, $at, $draft, $errors),
            };
        }
    }

    private static function component(mixed $value, array $rule, array $path, bool $creating, bool $draft, array &$errors): void
    {
        if (! ($rule['repeatable'] ?? false)) {
            if ($value === null) {
                return;
            }
            if (! is_array($value) || ($value !== [] && array_is_list($value))) {
                $errors[] = self::notType($path, 'object', $value);

                return;
            }
            self::object($value, $rule['fields'], $path, $creating, $draft, $errors);

            return;
        }
        if (! is_array($value) || ! array_is_list($value)) {
            $errors[] = self::notType($path, 'array', $value);

            return;
        }
        foreach ($value as $i => $item) {
            if (! is_array($item) || ($item !== [] && array_is_list($item))) {
                $errors[] = self::notType([...$path, (string) $i], 'object', $item);
                continue;
            }
            self::object($item, $rule['fields'], [...$path, (string) $i], $creating, $draft, $errors);
        }
    }

    /** A zone's items by their component; one naming a component the zone lacks is StrapiZones' to refuse or drop. */
    private static function zone(mixed $value, array $rule, array $path, bool $creating, bool $draft, array &$errors): void
    {
        foreach (is_array($value) && array_is_list($value) ? $value : [] as $i => $item) {
            $fields = is_array($item) ? ($rule['components'][$item['__component'] ?? ''] ?? null) : null;
            if ($fields !== null) {
                self::object($item, $fields, [...$path, (string) $i], $creating, $draft, $errors);
            }
        }
    }

    private static function scalar(mixed $value, array $rule, array $path, bool $draft, array &$errors): void
    {
        $type = $rule['type'];
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
        array_push($errors, ...match (true) {
            in_array($type, self::STRINGS, true) => self::string($value, $rule, $path, $draft),
            in_array($type, self::NUMBERS, true) => self::number($value, $rule, $path, $draft),
            $type === 'biginteger' => self::bigInteger($value, $path),
            $type === 'boolean' => self::boolean($value, $path),
            default => [],
        });
    }

    private static function string(mixed $value, array $rule, array $path, bool $draft): array
    {
        if (! is_string($value)) {
            return [self::notType($path, 'string', $value)];
        }
        $type = $rule['type'];
        if ($type === 'enumeration') {
            return in_array($value, $rule['enum'], true)
                ? []
                : [self::error($path, '{path} must be one of the following values: ' . implode(', ', [...$rule['enum'], 'null']), $value)];
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

    /** yup's number: a numeric string is cast, anything else that is not a number is NaN. */
    private static function number(mixed $value, array $rule, array $path, bool $draft): array
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
        if ($rule['type'] === 'integer' && is_float($cast) && floor($cast) !== $cast) {
            $found[] = self::error($path, '{path} must be an integer', $cast);
        }
        if ($rule['type'] !== 'integer' && ! is_finite((float) $cast)) {
            $found[] = self::error($path, '{path} must be a finite number', $cast);
        }
        if (! $draft && isset($rule['min']) && $cast < $rule['min']) {
            $found[] = self::error($path, '{path} must be greater than or equal to ' . self::print($rule['min']), $cast);
        }
        if (isset($rule['max']) && $cast > $rule['max']) {
            $found[] = self::error($path, '{path} must be less than or equal to ' . self::print($rule['max']), $cast);
        }

        return $found;
    }

    private static function bigInteger(mixed $value, array $path): array
    {
        $valid = is_int($value)
            || (is_float($value) && is_finite($value) && floor($value) === $value)
            || (is_string($value) && preg_match('/^[+-]?\d+$/', trim($value)) === 1);

        return $valid ? [] : [self::error($path, '{path} must be a valid integer', $value)];
    }

    /** yup's boolean: true and 1, false and 0, as words or numbers, are cast. */
    private static function boolean(mixed $value, array $path): array
    {
        $cast = is_bool($value) || (is_scalar($value) && preg_match('/^(true|1|false|0)$/i', (string) $value) === 1);

        return $cast ? [] : [self::notType($path, 'boolean', $value)];
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
            ? ' (cast from the value ${TICK}' . self::print($original, true) . '${TICK}).'
            : '.';

        return self::error($path, "{path} must be a ${TICK}{$type}${TICK} type, but the final value was: ${TICK}" . self::print($value, true) . '${TICK}' . $cast, $value);
    }

    /**
     * One of Strapi's details.errors, its message starting with the field's path; a value left out
     * was not sent, as yup leaves it undefined.
     */
    private static function error(array $path, string $message, mixed ...$value): array
    {
        $error = ['path' => $path, 'message' => self::label($path) . substr($message, strlen('{path}')), 'name' => 'ValidationError'];

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
`;
