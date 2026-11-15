<?php

declare(strict_types=1);

namespace App\Support;

use Filament\Forms\Components\Repeater;
use Filament\Forms\Components\Select;
use Filament\Schemas\Components\Component;
use Filament\Schemas\Components\Fieldset;
use Filament\Schemas\Components\Grid;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;
use Filament\Tables\Columns\Column;
use Filament\Tables\Filters\QueryBuilder;
use Filament\Tables\Table;
use Filament\Infolists\Components\TextEntry;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

/**
 * $view is a resource's CONTENT_MANAGER: the type's uid, and for each attribute in schema order
 * its Strapi type, whether the list shows it (list), sorts by it (sort), the edit view shows it
 * (edit), and its default size in a row of 12 (size, resizable).
 */
final class StrapiContentManager
{
    public const PAGE_SIZES = [10, 20, 50, 100];

    public const SIZES = [4, 6, 8, 12];

    private const DEFAULT_LIST_LENGTH = 4;

    private const MAX_ROW_SIZE = 12;

    private const SETTINGS = ['searchable', 'filterable', 'bulkable', 'pageSize', 'mainField', 'defaultSortBy', 'defaultSortOrder'];

    /** Where the configurations are kept: a type's under its uid, a component's under components::<uid>. */
    public const KEY_PREFIX = 'content-manager.configuration.';

    /** Where Strapi's core store keeps them, by the prefix each kind's keys have here. */
    private const STRAPI_KEYS = [
        'components::' => 'plugin_content_manager_configuration_components::',
        '' => 'plugin_content_manager_configuration_content_types::',
    ];

    /** The setting the configuration is kept under. */
    public static function key(array $view): string
    {
        return self::KEY_PREFIX . $view['uid'];
    }

    /**
     * The setting a Strapi core-store key's configuration is kept under, with the type's or
     * component's uid; null for a key that holds none.
     *
     * @return array{0: string, 1: string}|null
     */
    public static function fromStrapiKey(string $strapiKey): ?array
    {
        foreach (self::STRAPI_KEYS as $kind => $prefix) {
            if (str_starts_with($strapiKey, $prefix)) {
                $uid = substr($strapiKey, strlen($prefix));

                return [self::KEY_PREFIX . $kind . $uid, $uid];
            }
        }

        return null;
    }

    /**
     * A kept configuration as Strapi's core store keeps it: its key, and its value naming the uid
     * (and, for a component, that it is one) as Strapi's do.
     *
     * @return array{0: string, 1: array<string, mixed>}
     */
    public static function toStrapi(string $key, array $configuration): array
    {
        $name = substr($key, strlen(self::KEY_PREFIX));
        foreach (self::STRAPI_KEYS as $kind => $prefix) {
            if ($kind === '' || str_starts_with($name, $kind)) {
                $uid = substr($name, strlen($kind));

                return [$prefix . $uid, $configuration + ['uid' => $uid] + ($kind === '' ? [] : ['isComponent' => true])];
            }
        }

        throw new \LogicException("No Strapi key for {$key}");
    }

    /** The configuration as saved, synced with the type as it is now. */
    public static function configuration(array $view): array
    {
        return self::sync($view, StrapiSettings::get(self::key($view)));
    }

    /**
     * Saves a configuration, keeping what Strapi stored beyond what this admin uses (such as
     * relationOpenMode, or a relation's mainField), so an export gives Strapi its view back whole.
     */
    public static function save(array $view, array $configuration): void
    {
        $synced = self::sync($view, $configuration);
        $stored = StrapiSettings::get(self::key($view));
        $shown = self::sync($view, $stored)['metadatas'];
        $metadatas = [];
        foreach ($synced['metadatas'] as $name => $metadata) {
            $kept = (array) ($stored['metadatas'][$name] ?? []);
            $metadatas[$name] = [
                'edit' => self::keepMainField((array) ($kept['edit'] ?? []), $metadata['edit'], $shown[$name]['edit']['mainField'] ?? null),
                'list' => self::keepMainField((array) ($kept['list'] ?? []), $metadata['list'], $shown[$name]['list']['mainField'] ?? null),
            ];
        }
        StrapiSettings::merge(self::key($view), [
            'settings' => array_replace((array) ($stored['settings'] ?? []), $synced['settings']),
            'metadatas' => $metadatas,
            'layouts' => $synced['layouts'],
        ]);
    }

    /**
     * The list as configured: its columns in the configured order (the others left to toggle on),
     * labelled and sorted as configured, searched and filtered only where enabled, paged by the
     * configured size and sorted by the configured attribute.
     *
     * @param array<string, Column> $columns each listable attribute's column
     * @param array<string, mixed> $constraints each filterable attribute's QueryBuilder constraint
     * @param list<Column> $after columns every list ends with (status, locale)
     */
    public static function table(Table $table, array $view, array $columns, array $constraints = [], array $after = [], array $filters = []): Table
    {
        ['settings' => $settings, 'metadatas' => $metadatas, 'layouts' => $layouts] = self::configuration($view);
        $shown = array_values(array_filter($layouts['list'], fn (string $name): bool => isset($columns[$name])));
        $ordered = [];
        foreach ([...$shown, ...array_diff(array_keys($columns), $shown)] as $name) {
            $column = $columns[$name];
            $list = $metadatas[$name]['list'] ?? [];
            $column->label(self::label($name, $list['label'] ?? $name))
                ->toggleable(isToggledHiddenByDefault: ! in_array($name, $shown, true));
            $main = self::mainFieldColumn($view['attributes'][$name] ?? [], $list);
            if ($main !== null && str_contains($column->getName(), '.')) {
                // A to-one relation's column, "<relation>.<main field>": its entry by the configured field.
                $relation = Str::before($column->getName(), '.');
                $column->getStateUsing(fn (Model $record): mixed => $record->getRelationValue($relation)?->getAttribute($main))->sortable(false);
            }
            if (($list['sortable'] ?? true) === false) {
                $column->sortable(false);
            }
            $ordered[] = $column;
        }
        if ($settings['filterable'] && $constraints !== []) {
            $filters[] = QueryBuilder::make()->constraints(array_values($constraints));
        }
        $sortBy = $settings['defaultSortBy'];

        if (! $settings['searchable']) {
            $table->searchable(false);
        }

        return $table->columns([...$ordered, ...$after])
            ->filters($filters)
            ->paginated(self::PAGE_SIZES)
            ->defaultPaginationPageOption((int) $settings['pageSize'])
            ->defaultSort(isset($columns[$sortBy]) ? $columns[$sortBy]->getName() : 'id', strtolower((string) $settings['defaultSortOrder']));
    }

    /** The list's bulk actions, unless the view turns them off. */
    public static function bulkActions(array $view, array $actions): array
    {
        return self::configuration($view)['settings']['bulkable'] ? $actions : [];
    }

    /**
     * The edit form as configured: each row of the edit layout a grid of 12, each attribute's
     * components sized, labelled, described and locked as configured. Components the layout leaves
     * out are hidden, so they are neither shown nor written. An entry's form ends with when and by
     * whom it was made and last changed, as Strapi's edit view does.
     *
     * @param array<string, list<Component>> $components each editable attribute's components
     * @param list<Component> $before components every form starts with (the locale)
     */
    public static function form(Schema $schema, array $view, array $components, array $before = []): Schema
    {
        ['metadatas' => $metadatas, 'layouts' => $layouts] = self::configuration($view);
        $rows = [];
        $placed = [];
        foreach ($layouts['edit'] as $row) {
            $cells = [];
            foreach ($row as $cell) {
                $name = $cell['name'];
                if (! isset($components[$name])) {
                    continue;
                }
                $placed[$name] = true;
                $cells[] = self::field($components[$name], $view['attributes'][$name], $name, $metadatas[$name]['edit'] ?? [], (int) $cell['size']);
            }
            if ($cells !== []) {
                $rows[] = Grid::make(self::MAX_ROW_SIZE)->schema($cells)->columnSpanFull();
            }
        }
        $hidden = [];
        foreach ($components as $name => $list) {
            if (! isset($placed[$name])) {
                foreach ($list as $component) {
                    $hidden[] = $component->hidden();
                }
            }
        }

        return $schema->columns(1)->components([...$before, ...$rows, ...$hidden, self::information()]);
    }

    /**
     * A component's fields laid out by its own view (Strapi's components::<uid> configuration):
     * each row of its edit layout a grid of 12, each field sized, labelled, described and locked
     * as configured, and a relation's entries titled by the main field it names. A field the view
     * does not lay out follows, full width: hiding it would lose its data. Without a saved view,
     * its fields in schema order.
     *
     * @param array<string, list<Component>> $fields each attribute's components, in schema order
     * @param list<string> $components the attributes that are components of their own
     * @return list<Component>
     */
    public static function component(string $uid, array $fields, array $components = []): array
    {
        $view = StrapiComponentViews::VIEWS[$uid] ?? null;
        $stored = self::componentView($uid);
        $rows = (array) ($stored['layouts']['edit'] ?? []);
        if ($rows === []) {
            return array_merge(...array_values($fields));
        }
        if ($view !== null) {
            ['metadatas' => $metadatas, 'layouts' => ['edit' => $rows]] = self::componentConfiguration($view);
        } else {
            $metadatas = (array) ($stored['metadatas'] ?? []);
        }
        $attribute = fn (string $name): array => $view['attributes'][$name]
            ?? ['type' => in_array($name, $components, true) ? 'component' : 'field'];
        $laidOut = [];
        $placed = [];
        foreach ($rows as $row) {
            $cells = [];
            foreach ((array) $row as $cell) {
                $name = $cell['name'] ?? null;
                if (! is_string($name) || ! isset($fields[$name]) || isset($placed[$name])) {
                    continue;
                }
                $placed[$name] = true;
                $type = $attribute($name)['type'] === 'component' ? 'component' : 'field';
                $cells[] = self::field($fields[$name], $attribute($name), $name, (array) ($metadatas[$name]['edit'] ?? []), self::componentCellSize($fields[$name], $type, $cell['size'] ?? null));
            }
            if ($cells !== []) {
                $laidOut[] = Grid::make(self::MAX_ROW_SIZE)->schema($cells)->columnSpanFull();
            }
        }
        foreach ($fields as $name => $list) {
            if (! isset($placed[$name])) {
                $laidOut[] = self::field($list, $attribute($name), $name, (array) ($metadatas[$name]['edit'] ?? []), self::MAX_ROW_SIZE);
            }
        }

        return $laidOut;
    }

    /**
     * A component's kept view, read once a request: a form asks for it at each use of the
     * component, every block and item included.
     */
    private static function componentView(string $uid): array
    {
        return once(fn (): array => StrapiSettings::get(self::KEY_PREFIX.'components::'.$uid));
    }

    /** A component's kept view synced with the component as it is now, once a request. */
    private static function componentConfiguration(array $view): array
    {
        return once(fn (): array => self::configuration($view));
    }

    /**
     * A cell's size in a component's view, as Strapi allows it: a component of its own or a
     * repeatable takes the full row, a field one of the sizes.
     *
     * @param list<Component> $components
     */
    private static function componentCellSize(array $components, string $type, mixed $size): int
    {
        $whole = $type === 'component' || $components[0] instanceof Repeater || $components[0] instanceof \Filament\Forms\Components\Builder;

        return ! $whole && in_array($size, self::SIZES, true) ? $size : self::MAX_ROW_SIZE;
    }

    /**
     * Fills a create form with an entry's content, its relations and components included, so
     * saving it makes a new entry: the repeaters forget the entry's items, which become new ones.
     *
     * @param class-string<Model> $model
     */
    public static function fillWith(Schema $form, Model $source, string $model): void
    {
        $form->model($source)->fill($source->attributesToArray());
        foreach ($form->getFlatComponents(withHidden: true) as $component) {
            if ($component instanceof Repeater) {
                $component->clearCachedExistingRecords();
            }
        }
        $form->model($model);
    }

    /** Strapi's Information panel: when the entry was made and last changed, and by whom. */
    private static function information(): Section
    {
        $by = fn (string $relation) => fn (?Model $record): string => $record?->{$relation}?->getAttribute('name') ?? '-';

        return Section::make('Information')
            ->schema([
                TextEntry::make('information_created')->label('Created')->state(fn (?Model $record) => $record?->getAttribute('created_at'))->dateTime(),
                TextEntry::make('information_created_by')->label('By')->state($by('createdBy')),
                TextEntry::make('information_updated')->label('Last update')->state(fn (?Model $record) => $record?->getAttribute('updated_at'))->dateTime(),
                TextEntry::make('information_updated_by')->label('By')->state($by('updatedBy')),
            ])
            ->columns(4)
            ->columnSpanFull()
            ->visibleOn('edit');
    }

    /**
     * An attribute's components as its metadata configures them: a component's fields boxed
     * under its name, a relation's entries labelled by the main field the view names.
     *
     * @param list<Component> $components
     * @param array<string, mixed> $attribute the attribute's entry in a view: its type, a relation's main fields
     */
    private static function field(array $components, array $attribute, string $name, array $edit, int $size): Component
    {
        $label = $edit['label'] ?? $name;
        $description = (string) ($edit['description'] ?? '');
        $placeholder = (string) ($edit['placeholder'] ?? '');
        $locked = ($edit['editable'] ?? true) === false;
        foreach ($components as $component) {
            if ($locked) {
                $component->disabled();
            }
        }
        if (count($components) > 1 || (($attribute['type'] ?? null) === 'component' && ! $components[0] instanceof Repeater)) {
            // An embedded component's fields, boxed under its name as Strapi shows a component.
            return Fieldset::make(self::label($name, $label))->schema($components)->columnSpan($size);
        }
        $component = $components[0];
        $column = self::mainFieldColumn($attribute, $edit);
        if ($column !== null && $component instanceof Select) {
            $component->getOptionLabelFromRecordUsing(fn (Model $record): string => (string) ($record->getAttribute($column) ?? $record->getKey()));
        }
        if ($label !== $name) {
            $component->label($label);
        }
        if ($description !== '' && method_exists($component, 'helperText')) {
            $component->helperText($description);
        }
        if ($placeholder !== '' && method_exists($component, 'placeholder')) {
            $component->placeholder($placeholder);
        }

        return $component->columnSpan($size);
    }

    /** The column of a relation's main field when its metadata names another than the default; else null. */
    private static function mainFieldColumn(array $attribute, array $metadata): ?string
    {
        $main = $metadata['mainField'] ?? null;
        if ($main === null || $main === ($attribute['mainField'] ?? null)) {
            return null;
        }

        return $attribute['mainFields'][$main] ?? null;
    }

    /** A label as configured, or the attribute's name made readable while it is left as Strapi's default. */
    public static function label(string $name, string $label): string
    {
        if ($label !== $name) {
            return $label;
        }

        return $name === 'id' ? 'ID' : Str::headline($name);
    }

    /** Strapi's main field by default: the first string attribute, else id. */
    private static function mainField(array $view): string
    {
        foreach ($view['attributes'] as $name => $attribute) {
            if ($attribute['type'] === 'string') {
                return $name;
            }
        }

        return 'id';
    }

    /** @return list<string> */
    public static function listable(array $view): array
    {
        return array_keys(array_filter($view['attributes'], fn (array $a): bool => $a['list']));
    }

    /** @return list<string> */
    public static function sortable(array $view): array
    {
        return array_keys(array_filter($view['attributes'], fn (array $a): bool => $a['sort']));
    }

    /** @return list<string> */
    public static function editable(array $view): array
    {
        return array_keys(array_filter($view['attributes'], fn (array $a): bool => $a['edit']));
    }

    /** The configuration Strapi makes for a type no one has configured. */
    public static function defaults(array $view): array
    {
        $main = self::mainField($view);
        $metadatas = [];
        foreach ($view['attributes'] as $name => $attribute) {
            // A relation's entries are labelled by its target's main field, as Strapi's metadatas say.
            $titled = isset($attribute['mainField']) ? ['mainField' => $attribute['mainField']] : [];
            $metadatas[$name] = [
                'edit' => $attribute['edit'] ? ['label' => $name, 'description' => '', 'placeholder' => '', 'visible' => true, 'editable' => true, ...$titled] : [],
                'list' => ['label' => $name, 'searchable' => $attribute['sort'], 'sortable' => $attribute['sort'], ...$titled],
            ];
        }

        return [
            'settings' => [
                'bulkable' => true,
                'filterable' => true,
                'searchable' => true,
                'pageSize' => 10,
                'mainField' => $main,
                'defaultSortBy' => $main,
                'defaultSortOrder' => 'ASC',
            ],
            'metadatas' => $metadatas,
            'layouts' => [
                'list' => array_slice(self::listable($view), 0, self::DEFAULT_LIST_LENGTH),
                'edit' => self::appendToEditLayout($view, [], self::editable($view)),
            ],
        ];
    }

    /**
     * A saved configuration against the type as it is now (strapi-php's syncSettings,
     * syncMetadatas and syncLayouts): what no longer exists is dropped, a size the attribute no
     * longer allows sends it to the end, and attributes added since are appended.
     */
    public static function sync(array $view, array $stored): array
    {
        $defaults = self::defaults($view);
        if (($stored['settings'] ?? []) === [] && ($stored['layouts'] ?? []) === []) {
            return $defaults;
        }
        $attributes = $view['attributes'];
        $settings = array_replace($defaults['settings'], array_intersect_key((array) ($stored['settings'] ?? []), array_flip(self::SETTINGS)));
        foreach (['mainField', 'defaultSortBy'] as $key) {
            if (! in_array($settings[$key], self::sortable($view), true)) {
                $settings[$key] = $defaults['settings'][$key];
            }
        }
        $settings['defaultSortOrder'] = strtoupper((string) $settings['defaultSortOrder']) === 'DESC' ? 'DESC' : 'ASC';
        if (! in_array((int) $settings['pageSize'], self::PAGE_SIZES, true)) {
            $settings['pageSize'] = 10;
        }

        $storedMetadatas = (array) ($stored['metadatas'] ?? []);
        $metadatas = [];
        foreach ($defaults['metadatas'] as $name => $metadata) {
            $saved = (array) ($storedMetadatas[$name] ?? []);
            $metadatas[$name] = [
                'edit' => $metadata['edit'] === [] ? [] : self::syncMainField($attributes[$name], array_replace($metadata['edit'], array_intersect_key((array) ($saved['edit'] ?? []), $metadata['edit']))),
                'list' => self::syncMainField($attributes[$name], array_replace($metadata['list'], array_intersect_key((array) ($saved['list'] ?? []), $metadata['list']))),
            ];
        }
        $added = array_values(array_diff(array_keys($attributes), array_keys($storedMetadatas)));

        $listable = self::listable($view);
        $list = array_values(array_unique(array_filter((array) ($stored['layouts']['list'] ?? []), fn (mixed $name): bool => in_array($name, $listable, true))));
        if (count($list) < self::DEFAULT_LIST_LENGTH) {
            $list = array_slice(array_values(array_unique([...$list, ...array_intersect($added, $listable)])), 0, self::DEFAULT_LIST_LENGTH);
        }

        $editable = self::editable($view);
        $edit = [];
        $reappend = [];
        $seen = [];
        foreach ((array) ($stored['layouts']['edit'] ?? []) as $row) {
            $kept = [];
            foreach ((array) $row as $cell) {
                $name = $cell['name'] ?? null;
                if (! in_array($name, $editable, true) || isset($seen[$name])) {
                    continue;
                }
                $seen[$name] = true;
                if (! self::allowsSize($attributes[$name], $cell['size'] ?? null)) {
                    $reappend[] = $name;

                    continue;
                }
                $kept[] = ['name' => $name, 'size' => (int) $cell['size']];
            }
            if ($kept !== []) {
                $edit[] = $kept;
            }
        }
        $edit = self::appendToEditLayout($view, $edit, $reappend);
        $edit = self::appendToEditLayout($view, $edit, array_values(array_filter($added, fn (string $name): bool => in_array($name, $editable, true) && ! isset($seen[$name]))));

        return [
            'settings' => $settings,
            'metadatas' => $metadatas,
            'layouts' => [
                'list' => $list !== [] ? $list : $defaults['layouts']['list'],
                'edit' => $edit !== [] ? $edit : $defaults['layouts']['edit'],
            ],
        ];
    }

    /**
     * Saved metadata over the kept. A relation's main field left as the form showed it keeps the
     * one Strapi stored, even one this admin does not have (and so showed its default for).
     */
    private static function keepMainField(array $kept, array $metadata, ?string $shown): array
    {
        if (isset($kept['mainField']) && ($metadata['mainField'] ?? null) === $shown) {
            unset($metadata['mainField']);
        }

        return array_replace($kept, $metadata);
    }

    /** A main field the relation's target no longer has goes back to the default one. */
    private static function syncMainField(array $attribute, array $metadata): array
    {
        if (isset($metadata['mainField']) && ! isset($attribute['mainFields'][$metadata['mainField']])) {
            $metadata['mainField'] = $attribute['mainField'];
        }

        return $metadata;
    }

    private static function allowsSize(array $attribute, mixed $size): bool
    {
        if (! is_int($size)) {
            return false;
        }
        if (! $attribute['resizable'] && $size !== $attribute['size']) {
            return false;
        }

        return $size <= self::MAX_ROW_SIZE;
    }

    /**
     * Fields appended to the edit layout as Strapi appends them: to the last row while it has
     * room, each at its default size (or the one given), then on a new row.
     *
     * @param list<list<array{name: string, size: int}>> $layout
     * @param list<string> $names
     * @param array<string, int> $sizes
     */
    public static function appendToEditLayout(array $view, array $layout, array $names, array $sizes = []): array
    {
        if ($names === []) {
            return $layout;
        }
        $row = max(count($layout) - 1, 0);
        $layout[$row] ??= [];
        foreach ($names as $name) {
            $size = $sizes[$name] ?? $view['attributes'][$name]['size'];
            if (array_sum(array_column($layout[$row], 'size')) + $size > self::MAX_ROW_SIZE) {
                $layout[++$row] = [];
            }
            $layout[$row][] = ['name' => $name, 'size' => $size];
        }

        return array_values(array_filter($layout, fn (array $cells): bool => $cells !== []));
    }

    /** The configuration as the "Configure the view" form edits it. */
    public static function formState(array $view): array
    {
        ['settings' => $settings, 'metadatas' => $metadatas, 'layouts' => $layouts] = self::configuration($view);
        $list = array_map(fn (string $name): array => [
            'name' => $name,
            'label' => $metadatas[$name]['list']['label'],
            'sortable' => (bool) $metadatas[$name]['list']['sortable'],
            'mainField' => $metadatas[$name]['list']['mainField'] ?? null,
        ], $layouts['list']);
        $edit = [];
        foreach (array_merge(...$layouts['edit']) as $cell) {
            $edit[] = self::editState($metadatas[$cell['name']]['edit'], $cell['name'], $cell['size'], true);
        }
        $placed = array_column($edit, 'name');
        foreach (self::editable($view) as $name) {
            if (! in_array($name, $placed, true)) {
                $edit[] = self::editState($metadatas[$name]['edit'], $name, $view['attributes'][$name]['size'], false);
            }
        }

        return ['settings' => $settings, 'list' => $list, 'edit' => $edit];
    }

    private static function editState(array $metadata, string $name, int $size, bool $shown): array
    {
        return [
            'name' => $name,
            'shown' => $shown,
            'size' => $size,
            'label' => $metadata['label'],
            'description' => $metadata['description'],
            'placeholder' => $metadata['placeholder'],
            'editable' => (bool) $metadata['editable'],
            'mainField' => $metadata['mainField'] ?? null,
        ];
    }

    /** @return array<string, string> the fields a relation's entries may be titled by, each by itself; none for another attribute */
    public static function mainFieldOptions(array $view, string $name): array
    {
        $fields = array_keys($view['attributes'][$name]['mainFields'] ?? []);

        return array_combine($fields, $fields);
    }

    /** A metadata with the main field the form chose, when the relation's target has it. */
    private static function withMainField(array $view, string $name, array $metadata, mixed $mainField): array
    {
        if (is_string($mainField) && isset($view['attributes'][$name]['mainFields'][$mainField])) {
            $metadata['mainField'] = $mainField;
        }

        return $metadata;
    }

    /** The configuration the "Configure the view" form describes. */
    public static function fromFormState(array $view, array $state): array
    {
        $configuration = self::configuration($view);
        $metadatas = $configuration['metadatas'];
        // A component's view has no list to configure: its own is kept.
        $list = array_key_exists('list', $state) ? [] : $configuration['layouts']['list'];
        foreach ($state['list'] ?? [] as $column) {
            $name = (string) $column['name'];
            $metadatas[$name]['list'] = self::withMainField($view, $name, array_replace($metadatas[$name]['list'], ['label' => (string) $column['label'], 'sortable' => (bool) $column['sortable']]), $column['mainField'] ?? null);
            $list[] = $name;
        }
        $shown = [];
        $sizes = [];
        foreach ($state['edit'] ?? [] as $field) {
            $name = (string) $field['name'];
            $metadatas[$name]['edit'] = self::withMainField($view, $name, array_replace($metadatas[$name]['edit'], [
                'label' => (string) $field['label'],
                'description' => (string) ($field['description'] ?? ''),
                'placeholder' => (string) ($field['placeholder'] ?? ''),
                'editable' => (bool) $field['editable'],
            ]), $field['mainField'] ?? null);
            if ((bool) $field['shown']) {
                $shown[] = $name;
                $sizes[$name] = (int) $field['size'];
            }
        }

        return [
            'settings' => array_replace($configuration['settings'], array_intersect_key($state['settings'] ?? [], array_flip(self::SETTINGS))),
            'metadatas' => $metadatas,
            'layouts' => ['list' => $list, 'edit' => self::appendToEditLayout($view, [], $shown, $sizes)],
        ];
    }

    /** The sizes an attribute may take in the edit layout. */
    public static function sizes(array $attribute): array
    {
        $sizes = $attribute['resizable'] ? self::SIZES : [$attribute['size']];

        return array_combine($sizes, array_map(fn (int $size): string => match ($size) {
            4 => 'Small (1/3)',
            6 => 'Half',
            8 => 'Large (2/3)',
            default => 'Full width',
        }, $sizes));
    }
}
