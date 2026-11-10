import { PHP_MARKER } from "../hooks/names";

export const CONTENT_TYPE_BUILDER_SCHEMA_PATH = "app/Support/ContentTypeBuilderSchema.php";

/**
 * The Content-Type Builder's edits of the content model and roles, as pure PHP functions of their
 * decoded JSON.
 */
export const emitContentTypeBuilderSchema = (): string =>
  `<?php
${PHP_MARKER}
` +
  String.raw`
declare(strict_types=1);

namespace App\Support;

use InvalidArgumentException;

/**
 * The Content-Type Builder's edits, as pure functions of the content model (the camis IR, decoded
 * as arrays) and the roles file. Nothing here reads or writes a file: ContentTypeBuilder does, and
 * "camis build" validates the result before anything is generated from it.
 */
final class ContentTypeBuilderSchema
{
    public const TYPE_NAME = '/^[A-Z][A-Za-z0-9]*$/';

    public const FIELD_NAME = '/^[a-z][A-Za-z0-9]*$/';

    public const CATEGORY = '/^[a-z0-9][a-z0-9_-]*$/';

    /** The role "camis new" makes, which may do everything, as Strapi's Super Admin. */
    public const SUPER_ADMIN_ROLE = 'super-admin';

    /** Strapi's attribute names it reserves on every type, beside camis's own "id". */
    private const RESERVED_FIELD_NAMES = ['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'locale', 'localizations'];

    /**
     * Strapi's field types, as its "Select a field" dialog offers them, each with the IR types it
     * stands for (the first is the default): Text is short or long, Number has its formats.
     */
    public const FIELD_KINDS = [
        'text' => ['label' => 'Text', 'description' => 'Small or long text like title or description', 'types' => ['string', 'text']],
        'blocks' => ['label' => 'Rich text (Blocks)', 'description' => 'The new JSON-based rich text editor', 'types' => ['blocks']],
        'number' => ['label' => 'Number', 'description' => 'Numbers (integer, float, decimal)', 'types' => ['integer', 'bigInteger', 'decimal', 'float']],
        'date' => ['label' => 'Date', 'description' => 'A date picker with hours, minutes and seconds', 'types' => ['date', 'dateTime', 'time', 'timestamp']],
        'media' => ['label' => 'Media', 'description' => 'Files like images, videos, etc', 'types' => ['media']],
        'relation' => ['label' => 'Relation', 'description' => 'Refers to a Collection Type', 'types' => ['relation']],
        'boolean' => ['label' => 'Boolean', 'description' => 'Yes or no, 1 or 0, true or false', 'types' => ['boolean']],
        'json' => ['label' => 'JSON', 'description' => 'Data in JSON format', 'types' => ['json']],
        'email' => ['label' => 'Email', 'description' => 'Email field with validations format', 'types' => ['email']],
        'enumeration' => ['label' => 'Enumeration', 'description' => 'List of values, then pick one', 'types' => ['enumeration']],
        'uid' => ['label' => 'UID', 'description' => 'Unique identifier', 'types' => ['uid']],
        'richText' => ['label' => 'Rich text (Markdown)', 'description' => 'The classic rich text editor', 'types' => ['richText']],
        'color' => ['label' => 'Color', 'description' => 'A color picker', 'types' => ['color']],
        'component' => ['label' => 'Component', 'description' => 'Group of fields that you can repeat or reuse', 'types' => ['component']],
        'dynamicZone' => ['label' => 'Dynamic zone', 'description' => 'Dynamically pick component when editing content', 'types' => ['dynamicZone']],
    ];

    public const RELATION_KINDS = [
        'oneToOne' => 'has one',
        'oneToMany' => 'has many',
        'manyToOne' => 'belongs to one',
        'manyToMany' => 'has and belongs to many',
    ];

    /** The keys the builder's forms own on a field; every other key a field carries is kept. */
    private const MANAGED_FIELD_KEYS = [
        'type', 'name', 'required', 'unique', 'private', 'minLength', 'maxLength', 'min', 'max',
        'default', 'pattern', 'values', 'multiple', 'allowedTypes', 'relationKind', 'target',
        'inverse', 'targetField', 'component', 'repeatable', 'components',
    ];

    // ---- reading -------------------------------------------------------------------------------

    /** A type's reference on the page: "contentType:Post" or "component:Money". */
    public static function ref(string $kind, string $name): string
    {
        return $kind.':'.$name;
    }

    /**
     * The model's types as Strapi's builder lists them: collection types, single types, then
     * components by category, each list in display-name order. The media library's file type is
     * the upload plugin's and Strapi hides it, so it is left out.
     *
     * @param  array<string, mixed>  $ir
     * @return array{collectionTypes: list<array<string, mixed>>, singleTypes: list<array<string, mixed>>, components: array<string, list<array<string, mixed>>>}
     */
    public static function navigation(array $ir): array
    {
        $types = array_values(array_filter(
            $ir['contentTypes'] ?? [],
            fn (array $type): bool => ($type['builtin'] ?? null) !== 'file',
        ));
        $byName = fn (array $a, array $b): int => strcasecmp(self::displayName($a), self::displayName($b));
        $collection = array_values(array_filter($types, fn (array $t): bool => $t['kind'] === 'collection'));
        $single = array_values(array_filter($types, fn (array $t): bool => $t['kind'] === 'single'));
        usort($collection, $byName);
        usort($single, $byName);
        $components = [];
        foreach ($ir['components'] ?? [] as $component) {
            $components[self::category($component)][] = $component;
        }
        ksort($components);
        foreach ($components as &$list) {
            usort($list, $byName);
        }

        return ['collectionTypes' => $collection, 'singleTypes' => $single, 'components' => $components];
    }

    /**
     * The content type or component a reference names, or null.
     *
     * @param  array<string, mixed>  $ir
     * @return array<string, mixed>|null
     */
    public static function find(array $ir, string $ref): ?array
    {
        [$kind, $name] = array_pad(explode(':', $ref, 2), 2, '');
        foreach ($ir[$kind === 'component' ? 'components' : 'contentTypes'] ?? [] as $node) {
            if ($node['name'] === $name) {
                return $node;
            }
        }

        return null;
    }

    /** @param array<string, mixed> $node */
    public static function displayName(array $node): string
    {
        return $node['names']['display'] ?? self::humanize($node['name']);
    }

    /** @param array<string, mixed> $component */
    public static function category(array $component): string
    {
        return $component['names']['group'] ?? 'shared';
    }

    /** Strapi's uid for a component: "<category>.<kebab-name>". */
    public static function componentUid(array $component): string
    {
        return self::category($component).'.'.self::kebab($component['name']);
    }

    /**
     * A field's row in the builder's list: its name, its type as Strapi names it, and what it
     * points at or allows.
     *
     * @param  array<string, mixed>  $field
     * @param  array<string, mixed>  $ir
     * @return array{name: string, type: string, details: string}
     */
    public static function fieldRow(array $field, array $ir): array
    {
        return ['name' => $field['name'], 'type' => self::typeLabel($field, $ir), 'details' => self::details($field)];
    }

    /** @param array<string, mixed> $field @param array<string, mixed> $ir */
    public static function typeLabel(array $field, array $ir): string
    {
        $type = $field['type'];

        return match ($type) {
            'string' => 'Text (short)',
            'text' => 'Text (long)',
            'integer', 'bigInteger', 'decimal', 'float' => 'Number ('.self::humanize($type).')',
            'date', 'dateTime', 'time', 'timestamp' => 'Date ('.self::humanize($type).')',
            'media' => ($field['multiple'] ?? false) ? 'Media (multiple)' : 'Media (single)',
            'relation' => 'Relation with '.self::targetName($ir, (string) $field['target']),
            'component' => 'Component '.self::componentLabel($ir, (string) $field['component']).(($field['repeatable'] ?? false) ? ' (repeatable)' : ''),
            'dynamicZone' => 'Dynamic zone',
            default => self::FIELD_KINDS[self::kindOf($type)]['label'],
        };
    }

    /** The builder kind (Strapi's field card) an IR type belongs to. */
    public static function kindOf(string $type): string
    {
        foreach (self::FIELD_KINDS as $kind => $definition) {
            if (in_array($type, $definition['types'], true)) {
                return $kind;
            }
        }
        throw new InvalidArgumentException("unknown field type \"{$type}\"");
    }

    /** @param array<string, mixed> $field */
    private static function details(array $field): string
    {
        $parts = [];
        foreach (['required' => 'required', 'unique' => 'unique', 'private' => 'private'] as $key => $label) {
            if (($field[$key] ?? false) === true) {
                $parts[] = $label;
            }
        }
        if ($field['type'] === 'relation') {
            array_unshift($parts, self::RELATION_KINDS[$field['relationKind']] ?? $field['relationKind']);
            if (isset($field['inverse'])) {
                $parts[] = 'inverse: '.$field['inverse'];
            }
        }
        if ($field['type'] === 'enumeration') {
            $parts[] = implode(', ', $field['values']);
        }
        if ($field['type'] === 'dynamicZone') {
            $parts[] = implode(', ', $field['components']);
        }
        if ($field['type'] === 'uid' && isset($field['targetField'])) {
            $parts[] = 'from '.$field['targetField'];
        }

        return implode(' · ', $parts);
    }

    /** @param array<string, mixed> $ir */
    private static function targetName(array $ir, string $name): string
    {
        $target = self::find($ir, self::ref('contentType', $name));

        return $target === null ? $name : self::displayName($target);
    }

    /** @param array<string, mixed> $ir */
    private static function componentLabel(array $ir, string $name): string
    {
        $component = self::find($ir, self::ref('component', $name));

        return $component === null ? $name : self::componentUid($component);
    }

    // ---- content types -------------------------------------------------------------------------

    /**
     * Strapi's "Create a collection type" (or single type): a display name, the type's name taken
     * from it, its plural, and the advanced settings Draft & Publish and Internationalization.
     *
     * @param  array<string, mixed>  $ir
     * @param  array{displayName: string, name?: string|null, plural?: string|null, draftPublish?: bool, localized?: bool}  $state
     * @return array<string, mixed>
     */
    public static function createContentType(array $ir, string $kind, array $state): array
    {
        $display = trim($state['displayName']);
        $name = trim((string) ($state['name'] ?? '')) ?: self::studly($display);
        self::assertTypeName($ir, $name);
        $type = ['name' => $name, 'kind' => $kind === 'single' ? 'single' : 'collection'];
        $names = array_filter([
            'display' => $display !== self::humanize($name) ? $display : null,
            'plural' => trim((string) ($state['plural'] ?? '')) ?: null,
        ]);
        if ($names !== []) {
            $type['names'] = $names;
        }
        $type['fields'] = [];
        $options = self::typeOptions([], $state);
        if ($options !== []) {
            $type['options'] = $options;
        }
        $ir['contentTypes'][] = $type;

        return $ir;
    }

    /**
     * Strapi's "Edit" on a type: its display name, plural and advanced settings. Its name is its
     * API ID, which Strapi does not let a type change once made.
     *
     * @param  array<string, mixed>  $ir
     * @param  array{displayName: string, plural?: string|null, draftPublish?: bool, localized?: bool}  $state
     * @return array<string, mixed>
     */
    public static function updateContentType(array $ir, string $name, array $state): array
    {
        return self::mapContentType($ir, $name, function (array $type) use ($state): array {
            $display = trim($state['displayName']);
            $names = $type['names'] ?? [];
            $names['display'] = $display !== self::humanize($type['name']) ? $display : null;
            if (($type['builtin'] ?? null) === null) {
                $names['plural'] = trim((string) ($state['plural'] ?? '')) ?: null;
            }
            $type['names'] = array_filter($names, fn ($value): bool => $value !== null);
            if ($type['names'] === []) {
                unset($type['names']);
            }
            $type['options'] = self::typeOptions($type['options'] ?? [], $state);
            if ($type['options'] === []) {
                unset($type['options']);
            }
            if (($type['options']['localized'] ?? false) !== true) {
                $type['fields'] = array_map(function (array $field): array {
                    unset($field['localized']);

                    return $field;
                }, $type['fields']);
            }

            return $type;
        });
    }

    /**
     * Delete a content type, with every relation that points at it and every hook, policy,
     * middleware or schedule bound to it, as Strapi drops a deleted type's relations.
     *
     * @param  array<string, mixed>  $ir
     * @return array<string, mixed>
     */
    public static function deleteContentType(array $ir, string $name): array
    {
        $type = self::find($ir, self::ref('contentType', $name)) ?? throw new InvalidArgumentException("content type \"{$name}\" does not exist");
        if (isset($type['builtin'])) {
            throw new InvalidArgumentException("content type \"{$name}\" belongs to a plugin and cannot be deleted");
        }
        $ir['contentTypes'] = array_values(array_filter($ir['contentTypes'], fn (array $t): bool => $t['name'] !== $name));
        $keep = fn (array $field): bool => ! ($field['type'] === 'relation' && $field['target'] === $name);
        foreach (['contentTypes', 'components'] as $list) {
            foreach ($ir[$list] as $i => $node) {
                $ir[$list][$i]['fields'] = array_values(array_filter($node['fields'], $keep));
            }
        }
        foreach (['hooks', 'policies', 'middlewares', 'schedules'] as $list) {
            if (isset($ir[$list])) {
                $ir[$list] = array_values(array_filter($ir[$list], fn (array $entry): bool => ($entry['contentType'] ?? null) !== $name));
            }
        }

        return $ir;
    }

    // ---- components ----------------------------------------------------------------------------

    /**
     * Strapi's "Create a component": a display name and a category.
     *
     * @param  array<string, mixed>  $ir
     * @param  array{displayName: string, name?: string|null, category: string}  $state
     * @return array<string, mixed>
     */
    public static function createComponent(array $ir, array $state): array
    {
        $name = trim((string) ($state['name'] ?? '')) ?: self::studly(trim($state['displayName']));
        self::assertTypeName($ir, $name);
        $category = self::assertCategory($state['category']);
        $ir['components'][] = ['name' => $name, 'names' => ['group' => $category], 'fields' => []];

        return $ir;
    }

    /**
     * A component's category; its name is its uid's, which Strapi does not let change.
     *
     * @param  array<string, mixed>  $ir
     * @param  array{category: string}  $state
     * @return array<string, mixed>
     */
    public static function updateComponent(array $ir, string $name, array $state): array
    {
        $category = self::assertCategory($state['category']);

        return self::mapComponent($ir, $name, function (array $component) use ($category): array {
            $component['names'] = [...($component['names'] ?? []), 'group' => $category];

            return $component;
        });
    }

    /**
     * Delete a component and every field that holds it: a component field goes, a dynamic zone
     * loses it (and goes when it held nothing else), as Strapi does.
     *
     * @param  array<string, mixed>  $ir
     * @return array<string, mixed>
     */
    public static function deleteComponent(array $ir, string $name): array
    {
        self::find($ir, self::ref('component', $name)) ?? throw new InvalidArgumentException("component \"{$name}\" does not exist");
        $ir['components'] = array_values(array_filter($ir['components'], fn (array $c): bool => $c['name'] !== $name));
        foreach (['contentTypes', 'components'] as $list) {
            foreach ($ir[$list] as $i => $node) {
                $fields = [];
                foreach ($node['fields'] as $field) {
                    if ($field['type'] === 'component' && $field['component'] === $name) {
                        continue;
                    }
                    if ($field['type'] === 'dynamicZone') {
                        $field['components'] = array_values(array_filter($field['components'], fn (string $c): bool => $c !== $name));
                        if ($field['components'] === []) {
                            continue;
                        }
                    }
                    $fields[] = $field;
                }
                $ir[$list][$i]['fields'] = $fields;
            }
        }

        return $ir;
    }

    // ---- fields --------------------------------------------------------------------------------

    /**
     * Add a field to a content type or component, from the field dialog's state.
     *
     * @param  array<string, mixed>  $ir
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    public static function addField(array $ir, string $ref, array $state): array
    {
        return self::mapNode($ir, $ref, function (array $node) use ($ref, $state, $ir): array {
            $field = self::fieldFromState([], $state, $ref, $ir);
            self::assertFieldName($node, $field['name']);
            $node['fields'][] = $field;

            return $node;
        });
    }

    /**
     * Change a field from the field dialog's state. Keys the dialog does not own (an imported
     * field's API name, a validation expression, …) are kept. A renamed field keeps the uid fields
     * generated from it pointing at it.
     *
     * @param  array<string, mixed>  $ir
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    public static function updateField(array $ir, string $ref, string $name, array $state): array
    {
        return self::mapNode($ir, $ref, function (array $node) use ($ref, $name, $state, $ir): array {
            $index = self::fieldIndex($node, $name);
            $field = self::fieldFromState($node['fields'][$index], $state, $ref, $ir);
            if ($field['name'] !== $name) {
                self::assertFieldName($node, $field['name']);
                foreach ($node['fields'] as $i => $other) {
                    if (($other['targetField'] ?? null) === $name) {
                        $node['fields'][$i]['targetField'] = $field['name'];
                    }
                }
                if (($node['options']['upsertBy'] ?? null) === $name) {
                    $node['options']['upsertBy'] = $field['name'];
                }
            }
            $node['fields'][$index] = $field;

            return $node;
        });
    }

    /**
     * Delete a field, and the uid fields' link to it.
     *
     * @param  array<string, mixed>  $ir
     * @return array<string, mixed>
     */
    public static function deleteField(array $ir, string $ref, string $name): array
    {
        return self::mapNode($ir, $ref, function (array $node) use ($name): array {
            $index = self::fieldIndex($node, $name);
            array_splice($node['fields'], $index, 1);
            foreach ($node['fields'] as $i => $other) {
                if (($other['targetField'] ?? null) === $name) {
                    unset($node['fields'][$i]['targetField']);
                }
            }
            if (($node['options']['upsertBy'] ?? null) === $name) {
                unset($node['options']['upsertBy']);
            }

            return $node;
        });
    }

    /**
     * The field dialog's state as an IR field, over the field it edits. Empty inputs drop their
     * key, so a cleared limit is no limit.
     *
     * @param  array<string, mixed>  $existing
     * @param  array<string, mixed>  $state
     * @param  array<string, mixed>  $ir
     * @return array<string, mixed>
     */
    public static function fieldFromState(array $existing, array $state, string $ref, array $ir): array
    {
        $type = self::typeFromState($state, $existing);
        $kind = self::kindOf($type);
        if (isset($existing['type']) && self::kindOf($existing['type']) !== $kind) {
            throw new InvalidArgumentException("field \"{$existing['name']}\" is a {$existing['type']} field; its type cannot change to {$type}");
        }
        if ($kind === 'dynamicZone' && str_starts_with($ref, 'component:')) {
            throw new InvalidArgumentException('a component cannot hold a dynamic zone');
        }
        $field = array_diff_key($existing, array_flip(self::MANAGED_FIELD_KEYS));
        $field = ['type' => $type, 'name' => trim((string) ($state['name'] ?? '')), ...$field];
        $flag = fn (string $key): ?bool => filter_var($state[$key] ?? false, FILTER_VALIDATE_BOOLEAN) ? true : null;
        $int = fn (string $key): ?int => is_numeric($state[$key] ?? null) ? (int) $state[$key] : null;
        $number = fn (string $key): int|float|null => is_numeric($state[$key] ?? null) ? 0 + $state[$key] : null;
        $text = fn (string $key): ?string => is_string($state[$key] ?? null) && trim($state[$key]) !== '' ? $state[$key] : null;
        $set = [
            'required' => $flag('required'),
            'private' => $flag('private'),
        ];
        if (in_array($type, ['string', 'text', 'richText', 'email', 'uid', 'integer', 'bigInteger', 'decimal', 'float'], true)) {
            $set['unique'] = $flag('unique');
        }
        if (in_array($type, ['string', 'text', 'richText', 'email', 'uid'], true)) {
            $set['minLength'] = $int('minLength');
            $set['maxLength'] = $int('maxLength');
        }
        if (in_array($type, ['string', 'text', 'richText', 'uid', 'color'], true)) {
            $set['pattern'] = $text('pattern');
        }
        match ($kind) {
            'number' => $set += ['min' => $number('min'), 'max' => $number('max'), 'default' => $number('default')],
            'boolean' => $set['default'] = match ($state['default'] ?? null) {
                true, 'true' => true,
                false, 'false' => false,
                default => null,
            },
            'json', 'blocks', 'media', 'relation', 'component', 'dynamicZone' => null,
            default => $set['default'] = $text('default'),
        };
        if ($kind === 'enumeration') {
            $values = is_array($state['values'] ?? null) ? $state['values'] : preg_split('/\R/', (string) ($state['values'] ?? ''));
            $set['values'] = array_values(array_unique(array_filter(array_map('trim', $values), fn (string $v): bool => $v !== '')));
            if ($set['values'] === []) {
                throw new InvalidArgumentException('an enumeration needs at least one value');
            }
        }
        if ($kind === 'media') {
            $set['multiple'] = $flag('multiple');
            $allowed = array_values(array_intersect(['image', 'video', 'audio', 'file'], (array) ($state['allowedTypes'] ?? [])));
            $set['allowedTypes'] = $allowed === [] || count($allowed) === 4 ? null : $allowed;
        }
        if ($kind === 'uid') {
            $set['targetField'] = $text('targetField');
        }
        if ($kind === 'relation') {
            $set['relationKind'] = array_key_exists((string) ($state['relationKind'] ?? ''), self::RELATION_KINDS) ? $state['relationKind'] : throw new InvalidArgumentException('choose how the relation links');
            $set['target'] = self::find($ir, self::ref('contentType', (string) ($state['target'] ?? ''))) !== null ? $state['target'] : throw new InvalidArgumentException('choose the content type the relation points at');
            $set['inverse'] = $text('inverse');
            if ($set['inverse'] !== null && ! preg_match(self::FIELD_NAME, $set['inverse'])) {
                throw new InvalidArgumentException("the inverse field name \"{$set['inverse']}\" must be camelCase");
            }
        }
        if ($kind === 'component') {
            $set['component'] = self::find($ir, self::ref('component', (string) ($state['component'] ?? ''))) !== null ? $state['component'] : throw new InvalidArgumentException('choose a component');
            $set['repeatable'] = filter_var($state['repeatable'] ?? false, FILTER_VALIDATE_BOOLEAN);
        }
        if ($kind === 'dynamicZone') {
            $components = array_values(array_filter((array) ($state['components'] ?? []), fn ($c): bool => is_string($c) && self::find($ir, self::ref('component', $c)) !== null));
            $set['components'] = $components !== [] ? $components : throw new InvalidArgumentException('a dynamic zone needs at least one component');
        }
        foreach ($set as $key => $value) {
            if ($value !== null) {
                $field[$key] = $value;
            }
        }

        return $field;
    }

    /**
     * The IR type the field dialog chose: its kind (Strapi's card), narrowed by the kind's own
     * choice where it has one (short or long text, a number's format, a date's type).
     *
     * @param  array<string, mixed>  $state
     * @param  array<string, mixed>  $existing
     */
    public static function typeFromState(array $state, array $existing = []): string
    {
        $kind = $state['kind'] ?? null;
        if (! is_string($kind) || ! isset(self::FIELD_KINDS[$kind])) {
            return (string) ($state['type'] ?? $existing['type'] ?? throw new InvalidArgumentException('choose a type of field'));
        }
        $types = self::FIELD_KINDS[$kind]['types'];
        $chosen = $state[match ($kind) {
            'text' => 'textType',
            'number' => 'numberType',
            'date' => 'dateType',
            default => 'type',
        }] ?? null;

        return in_array($chosen, $types, true) ? $chosen : $types[0];
    }

    /**
     * A field as the field dialog's state, the inverse of fieldFromState.
     *
     * @param  array<string, mixed>  $field
     * @return array<string, mixed>
     */
    public static function stateFromField(array $field): array
    {
        $kind = self::kindOf($field['type']);
        $state = array_intersect_key($field, array_flip(self::MANAGED_FIELD_KEYS));
        $state['kind'] = $kind;
        match ($kind) {
            'text' => $state['textType'] = $field['type'],
            'number' => $state['numberType'] = $field['type'],
            'date' => $state['dateType'] = $field['type'],
            default => null,
        };
        if ($kind === 'enumeration') {
            $state['values'] = implode("\n", $field['values']);
        }
        if ($kind === 'boolean' && isset($field['default'])) {
            $state['default'] = $field['default'] ? 'true' : 'false';
        }
        if ($kind === 'media' && ! isset($field['allowedTypes'])) {
            $state['allowedTypes'] = ['image', 'video', 'audio', 'file'];
        }

        return $state;
    }

    // ---- roles ---------------------------------------------------------------------------------

    /**
     * The roles file after an edit: a deleted type leaves no grant behind and a type without
     * Draft & Publish no publish action, as "camis build" would refuse either; and the type the
     * edit made or changed is the super-admin role's to do everything with, as Strapi's Super
     * Admin may with every type.
     *
     * @param  array<string, mixed>  $roles
     * @param  array<string, mixed>  $ir
     * @return array<string, mixed>
     */
    public static function syncRoles(array $roles, array $ir, ?string $touched = null): array
    {
        $types = [];
        $fields = [];
        foreach ($ir['contentTypes'] as $type) {
            $types[$type['name']] = ($type['options']['draftPublish'] ?? false) === true;
            $fields[$type['name']] = array_column($type['fields'], 'name');
        }
        foreach ($roles['roles'] ?? [] as $r => $role) {
            $grants = [];
            foreach ($role['grants'] ?? [] as $grant) {
                if (! array_key_exists($grant['contentType'], $types)) {
                    continue;
                }
                if (! $types[$grant['contentType']]) {
                    $grant['actions'] = array_values(array_filter($grant['actions'], fn (string $a): bool => $a !== 'publish'));
                    if ($grant['actions'] === []) {
                        continue;
                    }
                }
                // A field rule or assignment naming a field the type no longer has goes with it.
                if (isset($grant['fieldRules'])) {
                    $grant['fieldRules'] = array_values(array_filter($grant['fieldRules'], fn (array $rule): bool => in_array($rule['field'], $fields[$grant['contentType']], true)));
                }
                if (isset($grant['assign'])) {
                    $grant['assign'] = array_intersect_key($grant['assign'], array_flip($fields[$grant['contentType']]));
                }
                $grants[] = $grant;
            }
            if ($touched !== null && array_key_exists($touched, $types) && $role['name'] === self::SUPER_ADMIN_ROLE) {
                $all = $types[$touched] ? ['create', 'read', 'update', 'delete', 'publish'] : ['create', 'read', 'update', 'delete'];
                $index = array_search($touched, array_column($grants, 'contentType'), true);
                if ($index === false) {
                    $grants[] = ['contentType' => $touched, 'actions' => $all];
                } elseif (! isset($grants[$index]['condition'])) {
                    $grants[$index]['actions'] = array_values(array_unique([...$grants[$index]['actions'], ...$all]));
                }
            }
            $roles['roles'][$r]['grants'] = $grants;
        }

        return $roles;
    }

    // ---- JSON ----------------------------------------------------------------------------------

    /**
     * A document as camis writes JSON: two-space indent and a trailing newline. PHP decodes "{}"
     * as an empty array, so the optional objects an edit emptied are dropped rather than written
     * as "[]".
     *
     * @param  array<string, mixed>  $document
     */
    public static function encode(array $document): string
    {
        $json = json_encode(self::dropEmptyObjects($document), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

        return preg_replace_callback('/^( +)/m', fn (array $m): string => str_repeat(' ', intdiv(strlen($m[1]), 2)), $json)."\n";
    }

    private static function dropEmptyObjects(mixed $value): mixed
    {
        if (! is_array($value)) {
            return $value;
        }
        foreach ($value as $key => $item) {
            if (in_array($key, ['names', 'options', 'inverseNames', 'assign'], true) && $item === []) {
                unset($value[$key]);

                continue;
            }
            $value[$key] = self::dropEmptyObjects($item);
        }

        return $value;
    }

    // ---- helpers -------------------------------------------------------------------------------

    /** "Blog post" → "BlogPost": a display name's PascalCase type name. */
    public static function studly(string $display): string
    {
        $ascii = preg_replace('/[^A-Za-z0-9]+/', ' ', $display) ?? '';

        return str_replace(' ', '', ucwords(strtolower(trim($ascii))));
    }

    /** "BlogPost" → "Blog Post". */
    public static function humanize(string $name): string
    {
        return ucfirst(trim((string) preg_replace('/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/', ' ', $name)));
    }

    public static function kebab(string $name): string
    {
        return strtolower((string) preg_replace('/[_\s]+/', '-', (string) preg_replace('/([a-z0-9])([A-Z])/', '$1-$2', $name)));
    }

    /** @param array<string, mixed> $state @param array<string, mixed> $options @return array<string, mixed> */
    private static function typeOptions(array $options, array $state): array
    {
        foreach (['draftPublish', 'localized'] as $key) {
            if (($state[$key] ?? false) === true) {
                $options[$key] = true;
            } else {
                unset($options[$key]);
            }
        }

        return $options;
    }

    /** @param array<string, mixed> $ir */
    private static function assertTypeName(array $ir, string $name): void
    {
        if (! preg_match(self::TYPE_NAME, $name)) {
            throw new InvalidArgumentException("the name \"{$name}\" must start with a letter and hold only letters and digits");
        }
        foreach ([...$ir['contentTypes'], ...$ir['components']] as $node) {
            if (strcasecmp($node['name'], $name) === 0) {
                throw new InvalidArgumentException("a content type or component named \"{$node['name']}\" already exists");
            }
        }
    }

    private static function assertCategory(string $category): string
    {
        $category = strtolower(trim($category));
        if (! preg_match(self::CATEGORY, $category)) {
            throw new InvalidArgumentException("the category \"{$category}\" must be lowercase letters, digits, - or _");
        }

        return $category;
    }

    /** @param array<string, mixed> $node */
    private static function assertFieldName(array $node, string $name): void
    {
        if (! preg_match(self::FIELD_NAME, $name)) {
            throw new InvalidArgumentException("the field name \"{$name}\" must be camelCase: a lowercase letter, then letters and digits");
        }
        if (in_array($name, self::RESERVED_FIELD_NAMES, true)) {
            throw new InvalidArgumentException("\"{$name}\" is a reserved name");
        }
        foreach ($node['fields'] as $field) {
            if ($field['name'] === $name) {
                throw new InvalidArgumentException("\"{$node['name']}\" already has a field named \"{$name}\"");
            }
        }
    }

    /** @param array<string, mixed> $node */
    private static function fieldIndex(array $node, string $name): int
    {
        foreach ($node['fields'] as $i => $field) {
            if ($field['name'] === $name) {
                return $i;
            }
        }
        throw new InvalidArgumentException("\"{$node['name']}\" has no field named \"{$name}\"");
    }

    /** @param array<string, mixed> $ir @return array<string, mixed> */
    private static function mapNode(array $ir, string $ref, callable $change): array
    {
        [$kind, $name] = array_pad(explode(':', $ref, 2), 2, '');

        return $kind === 'component' ? self::mapComponent($ir, $name, $change) : self::mapContentType($ir, $name, $change);
    }

    /** @param array<string, mixed> $ir @return array<string, mixed> */
    private static function mapContentType(array $ir, string $name, callable $change): array
    {
        foreach ($ir['contentTypes'] as $i => $type) {
            if ($type['name'] === $name) {
                $ir['contentTypes'][$i] = $change($type);

                return $ir;
            }
        }
        throw new InvalidArgumentException("content type \"{$name}\" does not exist");
    }

    /** @param array<string, mixed> $ir @return array<string, mixed> */
    private static function mapComponent(array $ir, string $name, callable $change): array
    {
        foreach ($ir['components'] as $i => $component) {
            if ($component['name'] === $name) {
                $ir['components'][$i] = $change($component);

                return $ir;
            }
        }
        throw new InvalidArgumentException("component \"{$name}\" does not exist");
    }
}
`;
