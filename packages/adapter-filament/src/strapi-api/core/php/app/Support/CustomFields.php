<?php

declare(strict_types=1);

namespace App\Support;

use Closure;
use Filament\Forms\Components\Field;
use RuntimeException;

/**
 * Strapi's custom fields registry: a plugin's input over one of Strapi's own types, registered as
 * Strapi registers one, its server half (strapi.customFields.register: name, plugin, type,
 * inputSize) and its admin half (app.customFields.register: a label, a description, an icon, the
 * Input component and the builder's options) in one call. The project registers its own in
 * App\CustomFields\Registrations, which camis seeds once and never overwrites.
 *
 * A field of the content model names its custom field as its editor ("plugin::stars.rating"); the
 * admin then edits it with the registered input, and the Content-Type Builder offers each
 * registered custom field beside Strapi's own cards.
 *
 * Strapi's inputSize is checked as Strapi checks it and sizes the field in the Content Manager's
 * edit view (StrapiContentManager), as Strapi's does; its icon is accepted but unused, as a builder
 * card has no icon.
 *
 * @phpstan-type CustomField array{uid: string, name: string, plugin: string|null, type: string, label: string, description: string, inputSize: array{size: int, resizable: bool}|null, input: Closure|null, options: Closure|null}
 */
final class CustomFields
{
    /** The Strapi types a custom field may store (Strapi's ALLOWED_TYPES, without password, which camis does not store). */
    public const TYPES = [
        'biginteger' => 'bigInteger', 'boolean' => 'boolean', 'date' => 'date', 'datetime' => 'dateTime',
        'decimal' => 'decimal', 'email' => 'email', 'enumeration' => 'enumeration', 'float' => 'float',
        'integer' => 'integer', 'json' => 'json', 'richtext' => 'richText', 'string' => 'string',
        'text' => 'text', 'time' => 'time', 'uid' => 'uid',
    ];

    /** @var array<string, CustomField> */
    private static array $fields = [];

    private static bool $booted = false;

    /**
     * Register one custom field, or a list of them, as Strapi's register takes them: { name, type,
     * plugin?, inputSize? }, with the admin's { label?, description?, icon?, input?, options? }.
     * "input" makes the admin's input, fn (string $name, array $options): Field; "options" the
     * builder's settings for it, fn (): array of form components, whose state is the options.
     *
     * @param  array<array-key, mixed>  $customField
     *
     * @throws RuntimeException with Strapi's message when one is not valid or is registered already
     */
    public static function register(array $customField): void
    {
        self::boot();
        foreach (array_is_list($customField) ? $customField : [$customField] as $field) {
            if (! is_array($field) || ! array_key_exists('name', $field) || ! array_key_exists('type', $field)) {
                throw new RuntimeException("Custom fields require a 'name' and 'type' key");
            }
            ['name' => $name, 'type' => $type] = $field;
            if ($type === 'password') {
                throw new RuntimeException("Custom field type: 'password' is a Strapi type camis does not store");
            }
            if (! is_string($type) || ! isset(self::TYPES[$type])) {
                $label = is_scalar($type) ? (string) $type : get_debug_type($type);
                throw new RuntimeException("Custom field type: '{$label}' is not a valid Strapi type or it can't be used with a Custom Field");
            }
            if (! is_string($name) || preg_match('/^(?![0-9])[a-zA-Z0-9$_-]+$/', $name) !== 1) {
                $label = is_scalar($name) ? (string) $name : get_debug_type($name);
                throw new RuntimeException("Custom field name: '{$label}' is not a valid object key");
            }
            $plugin = is_scalar($field['plugin'] ?? null) && (bool) $field['plugin'] ? (string) $field['plugin'] : null;
            $uid = $plugin !== null ? "plugin::{$plugin}.{$name}" : "global::{$name}";
            $inputSize = self::inputSize($field['inputSize'] ?? null);
            if (isset(self::$fields[$uid])) {
                throw new RuntimeException("Custom field: '{$uid}' has already been registered");
            }
            self::$fields[$uid] = [
                'uid' => $uid,
                'name' => $name,
                'plugin' => $plugin,
                'type' => $type,
                'label' => is_string($field['label'] ?? null) ? $field['label'] : ucfirst(trim((string) preg_replace('/([a-z0-9])([A-Z])/', '$1 $2', $name))),
                'description' => is_string($field['description'] ?? null) ? $field['description'] : '',
                'inputSize' => $inputSize,
                'input' => ($field['input'] ?? null) instanceof Closure ? $field['input'] : null,
                'options' => ($field['options'] ?? null) instanceof Closure ? $field['options'] : null,
            ];
        }
    }

    /** @return array<string, CustomField> every registered custom field, by its uid */
    public static function all(): array
    {
        self::boot();

        return self::$fields;
    }

    /**
     * The custom field a uid names, or null. As Strapi, a "plugin::<plugin>.<name>" a schema names
     * finds the one registered without its plugin, under "global::<name>".
     *
     * @return CustomField|null
     */
    public static function find(string $uid): ?array
    {
        $fields = self::all();
        if (isset($fields[$uid])) {
            return $fields[$uid];
        }
        if (preg_match('/^plugin::[a-z0-9-_]+\.(.+)$/i', $uid, $match) === 1) {
            return $fields["global::{$match[1]}"] ?? null;
        }

        return null;
    }

    /** The content model's type a custom field stores (Strapi's "biginteger" is "bigInteger"). */
    public static function irType(string $uid): ?string
    {
        $field = self::find($uid);

        return $field === null ? null : self::TYPES[$field['type']];
    }

    /**
     * The admin's input for a field edited with a registered custom field, or null when none is
     * registered under its uid (or it registered no input): the admin then shows its type's own.
     *
     * @param  array<string, mixed>  $options  the field's options, as the builder set them
     */
    public static function input(string $uid, string $name, array $options = []): ?Field
    {
        $input = self::find($uid)['input'] ?? null;

        return $input === null ? null : $input($name, $options);
    }

    /** Forget every registration; for tests. */
    public static function flush(): void
    {
        self::$fields = [];
        self::$booted = true;
    }

    private static function boot(): void
    {
        if (self::$booted) {
            return;
        }
        self::$booted = true;
        $registrations = 'App\\CustomFields\\Registrations';
        if (! class_exists($registrations)) {
            return;
        }
        try {
            (new $registrations)();
        } catch (\Throwable $exception) {
            // Asked again next time, rather than leaving the registrations before the one that failed.
            self::$fields = [];
            self::$booted = false;

            throw $exception;
        }
    }

    /**
     * Strapi's inputSize, checked as Strapi checks it: the size the edit view gives the field, and
     * whether it may be given another.
     *
     * @return array{size: int, resizable: bool}|null
     */
    private static function inputSize(mixed $inputSize): ?array
    {
        if ($inputSize === null || $inputSize === false) {
            return null;
        }
        if (! is_array($inputSize) || ! array_key_exists('default', $inputSize) || ! array_key_exists('isResizable', $inputSize)) {
            throw new RuntimeException("inputSize should be an object with 'default' and 'isResizable' keys");
        }
        if (! in_array($inputSize['default'], [4, 6, 8, 12], true)) {
            throw new RuntimeException('Custom fields require a valid default input size');
        }
        if (! is_bool($inputSize['isResizable'])) {
            throw new RuntimeException('Custom fields should specify if their input is resizable');
        }

        return ['size' => $inputSize['default'], 'resizable' => $inputSize['isResizable']];
    }
}
