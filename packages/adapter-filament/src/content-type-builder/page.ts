import { PHP_MARKER } from "../hooks/names";

export const CONTENT_TYPE_BUILDER_PAGE_PATH = "app/Filament/Pages/ContentTypeBuilder.php";

/**
 * Strapi's Content-Type Builder as a Filament page: the model's types in a side menu, the chosen
 * one's fields in a list, and in development the dialogs that edit them. Whoever may change the
 * admin's settings may open it when the project has roles.
 */
export const emitContentTypeBuilderPage = (secured: boolean): string =>
  `<?php
${PHP_MARKER}
` +
  String.raw`
declare(strict_types=1);

namespace App\Filament\Pages;

use App\Support\ContentTypeBuilder as Builder;
use App\Support\ContentTypeBuilderSchema as ModelSchema;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Actions\ActionGroup;
use Filament\Forms\Components\CheckboxList;
use Filament\Forms\Components\Radio;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\Textarea;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Navigation\NavigationItem;
use Filament\Notifications\Notification;
use Filament\Pages\Enums\SubNavigationPosition;
use Filament\Pages\Page;
use Filament\Schemas\Components\EmbeddedTable;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Components\Tabs;
use Filament\Schemas\Components\Tabs\Tab;
use Filament\Schemas\Components\Text;
use Filament\Schemas\Components\Utilities\Get;
use Filament\Schemas\Schema;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Concerns\InteractsWithTable;
use Filament\Tables\Contracts\HasTable;
use Filament\Tables\Table;
use Illuminate\Contracts\Support\Htmlable;
use Livewire\Attributes\Url;
use RuntimeException;

/**
 * Strapi's Content-Type Builder: the content model's collection types, single types and components
 * in a side menu, the chosen one's fields in a list. Read-only unless the app runs under
 * "camis develop" (see ContentTypeBuilder); there each edit goes to the IR and rebuilds the app.
 */
class ContentTypeBuilder extends Page implements HasTable
{
    use InteractsWithTable;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-puzzle-piece';

    protected static ?string $navigationLabel = 'Content-Type Builder';

    protected static ?int $navigationSort = -1;

    protected static ?string $slug = 'content-type-builder';

    protected static ?SubNavigationPosition $subNavigationPosition = SubNavigationPosition::Start;

    /** The type on show: "contentType:<Name>" or "component:<Name>". */
    #[Url]
    public ?string $type = null;

    /** @var array<string, mixed>|null */
    private ?array $document = null;

    public static function canAccess(): bool
    {
        return ` +
  (secured ? "auth()->user()?->can('user.update') ?? false" : "true") +
  String.raw`;
    }

    public function mount(): void
    {
        if ($this->type === null || ModelSchema::find($this->document(), $this->type) === null) {
            $this->type = $this->firstType();
        }
    }

    public function getTitle(): string | Htmlable
    {
        $node = $this->node();

        return $node === null ? 'Content-Type Builder' : ModelSchema::displayName($node);
    }

    public function getSubheading(): ?string
    {
        $node = $this->node();
        if ($node === null) {
            return 'Build the data architecture of your content';
        }
        if (str_starts_with((string) $this->type, 'component:')) {
            return 'Component · '.ModelSchema::componentUid($node);
        }

        return ($node['kind'] === 'single' ? 'Single type' : 'Collection type').' · '.$this->contentTypeUid($node);
    }

    /** @return array<NavigationItem> */
    public function getSubNavigation(): array
    {
        $navigation = ModelSchema::navigation($this->document());
        $item = fn (array $node, string $kind, string $group): NavigationItem => NavigationItem::make(ModelSchema::displayName($node))
            ->group($group)
            ->url(static::getUrl(['type' => ModelSchema::ref($kind, $node['name'])]))
            ->isActiveWhen(fn (): bool => $this->type === ModelSchema::ref($kind, $node['name']));
        $items = [];
        foreach ($navigation['collectionTypes'] as $node) {
            $items[] = $item($node, 'contentType', 'Collection Types');
        }
        foreach ($navigation['singleTypes'] as $node) {
            $items[] = $item($node, 'contentType', 'Single Types');
        }
        foreach ($navigation['components'] as $category => $components) {
            foreach ($components as $node) {
                $items[] = $item($node, 'component', 'Components · '.$category);
            }
        }

        return $items;
    }

    public function content(Schema $schema): Schema
    {
        $reason = Builder::readOnlyReason();

        return $schema->components([
            ...($reason === null ? [] : [Section::make()->schema([Text::make($reason)])]),
            EmbeddedTable::make(),
        ]);
    }

    public function table(Table $table): Table
    {
        return $table
            ->records(fn (): array => $this->fieldRows())
            ->columns([
                TextColumn::make('name')->label('Name')->weight('medium'),
                TextColumn::make('type')->label('Type')->badge()->color('gray'),
                TextColumn::make('details')->label('Details')->color('gray'),
            ])
            ->paginated(false)
            ->emptyStateHeading('Add your first field to this '.(str_starts_with((string) $this->type, 'component:') ? 'component' : 'content type'))
            ->emptyStateIcon('heroicon-o-puzzle-piece')
            ->headerActions([$this->addFieldAction()])
            ->recordActions([$this->editFieldAction(), $this->deleteFieldAction()]);
    }

    /** @return array<Action|ActionGroup> */
    protected function getHeaderActions(): array
    {
        return [
            ActionGroup::make([
                $this->createContentTypeAction('collection'),
                $this->createContentTypeAction('single'),
                $this->createComponentAction(),
            ])->label('Create new')->icon('heroicon-o-plus')->button()->visible(fn (): bool => Builder::editable()),
            $this->editTypeAction(),
            $this->deleteTypeAction(),
        ];
    }

    // ---- types ---------------------------------------------------------------------------------

    private function createContentTypeAction(string $kind): Action
    {
        $label = $kind === 'single' ? 'single type' : 'collection type';

        return Action::make('create'.ucfirst($kind).'Type')
            ->label('Create new '.$label)
            ->modalHeading('Create a '.$label)
            ->schema([
                Tabs::make()->tabs([
                    Tab::make('Basic settings')->schema([
                        TextInput::make('displayName')->label('Display name')->required()->live(onBlur: true),
                        TextInput::make('name')->label('API ID (singular)')
                            ->placeholder(fn (Get $get): string => ModelSchema::studly((string) $get('displayName')))
                            ->helperText('The type\'s name in the content model: PascalCase, taken from the display name when left empty. It cannot change later.')
                            ->regex(ModelSchema::TYPE_NAME),
                        TextInput::make('plural')->label('API ID (plural)')->visible($kind === 'collection')
                            ->helperText('Left empty, the name is pluralized.'),
                    ]),
                    Tab::make('Advanced settings')->schema($this->typeOptionsSchema()),
                ]),
            ])
            ->fillForm(['draftPublish' => true])
            ->action(fn (array $data, Action $action) => $this->save(
                $action,
                fn (array $ir): array => ModelSchema::createContentType($ir, $kind, $data),
                touched: fn (array $ir): string => (string) end($ir['contentTypes'])['name'],
                next: fn (array $ir): string => ModelSchema::ref('contentType', (string) end($ir['contentTypes'])['name']),
            ));
    }

    private function createComponentAction(): Action
    {
        return Action::make('createComponent')
            ->label('Create new component')
            ->modalHeading('Create a component')
            ->schema([
                TextInput::make('displayName')->label('Display name')->required(),
                TextInput::make('name')->label('Name')->regex(ModelSchema::TYPE_NAME)
                    ->helperText('PascalCase, taken from the display name when left empty. It cannot change later.'),
                $this->categoryInput(),
            ])
            ->action(fn (array $data, Action $action) => $this->save(
                $action,
                fn (array $ir): array => ModelSchema::createComponent($ir, $data),
                next: fn (array $ir): string => ModelSchema::ref('component', (string) end($ir['components'])['name']),
            ));
    }

    private function editTypeAction(): Action
    {
        return Action::make('editType')
            ->label('Edit')
            ->icon('heroicon-o-pencil')
            ->color('gray')
            ->visible(fn (): bool => Builder::editable() && $this->node() !== null)
            ->modalHeading(fn (): string => 'Edit '.$this->getTitle())
            ->fillForm(function (): array {
                $node = (array) $this->node();

                return [
                    'displayName' => ModelSchema::displayName($node),
                    'plural' => $node['names']['plural'] ?? null,
                    'draftPublish' => ($node['options']['draftPublish'] ?? false) === true,
                    'localized' => ($node['options']['localized'] ?? false) === true,
                    'category' => isset($node['kind']) ? null : ModelSchema::category($node),
                ];
            })
            ->schema(fn (): array => str_starts_with((string) $this->type, 'component:')
                ? [$this->categoryInput()]
                : [
                    TextInput::make('displayName')->label('Display name')->required(),
                    TextInput::make('plural')->label('API ID (plural)')
                        ->visible(fn (): bool => ($this->node()['kind'] ?? null) === 'collection' && ! isset($this->node()['builtin'])),
                    ...$this->typeOptionsSchema(),
                ])
            ->action(function (array $data, Action $action): void {
                $name = (string) $this->node()['name'];
                if (str_starts_with((string) $this->type, 'component:')) {
                    $this->save($action, fn (array $ir): array => ModelSchema::updateComponent($ir, $name, $data));

                    return;
                }
                $this->save($action, fn (array $ir): array => ModelSchema::updateContentType($ir, $name, $data), touched: fn (): string => $name);
            });
    }

    private function deleteTypeAction(): Action
    {
        return Action::make('deleteType')
            ->label('Delete')
            ->icon('heroicon-o-trash')
            ->color('danger')
            ->outlined()
            ->requiresConfirmation()
            ->modalDescription('Are you sure you want to delete it? Its data, and every field that refers to it, will be deleted too.')
            ->visible(fn (): bool => Builder::editable() && $this->node() !== null && ! isset($this->node()['builtin']))
            ->action(function (Action $action): void {
                $name = (string) $this->node()['name'];
                $component = str_starts_with((string) $this->type, 'component:');
                $this->save(
                    $action,
                    fn (array $ir): array => $component ? ModelSchema::deleteComponent($ir, $name) : ModelSchema::deleteContentType($ir, $name),
                    next: fn (array $ir): ?string => null,
                );
            });
    }

    /** @return list<\Filament\Schemas\Components\Component|\Filament\Forms\Components\Field> */
    private function typeOptionsSchema(): array
    {
        return [
            Toggle::make('draftPublish')->label('Draft & publish')
                ->helperText('Allows writing a draft version of an entry, before it is published'),
            Toggle::make('localized')->label('Internationalization')
                ->helperText('Allows translating an entry into different languages'),
        ];
    }

    private function categoryInput(): TextInput
    {
        $categories = array_keys(ModelSchema::navigation($this->document())['components']);

        return TextInput::make('category')->label('Category')->required()
            ->datalist($categories)
            ->regex(ModelSchema::CATEGORY)
            ->helperText('Pick a category or type a new one: lowercase letters, digits, - or _.');
    }

    // ---- fields --------------------------------------------------------------------------------

    private function addFieldAction(): Action
    {
        return Action::make('addField')
            ->label(fn (): string => $this->fieldRows() === [] ? 'Add new field' : 'Add another field')
            ->icon('heroicon-o-plus')
            ->visible(fn (): bool => Builder::editable() && $this->node() !== null)
            ->modalHeading(fn (): string => 'Add a field to '.$this->getTitle())
            ->schema(fn (): array => $this->fieldSchema(adding: true))
            ->action(fn (array $data, Action $action) => $this->save(
                $action,
                fn (array $ir): array => ModelSchema::addField($ir, (string) $this->type, $data),
            ));
    }

    private function editFieldAction(): Action
    {
        return Action::make('editField')
            ->label('Edit')
            ->icon('heroicon-o-pencil')
            ->iconButton()
            ->visible(fn (array $record): bool => Builder::editable() && ModelSchema::designable($this->field($record['name'])))
            ->modalHeading(fn (array $record): string => 'Edit '.$record['name'])
            ->fillForm(fn (array $record): array => ModelSchema::stateFromField($this->field($record['name'])))
            ->schema(fn (): array => $this->fieldSchema(adding: false))
            ->action(fn (array $record, array $data, Action $action) => $this->save(
                $action,
                fn (array $ir): array => ModelSchema::updateField($ir, (string) $this->type, $record['name'], $data),
            ));
    }

    private function deleteFieldAction(): Action
    {
        return Action::make('deleteField')
            ->label('Delete')
            ->icon('heroicon-o-trash')
            ->iconButton()
            ->color('danger')
            ->requiresConfirmation()
            ->modalHeading(fn (array $record): string => 'Delete '.$record['name'])
            ->modalDescription('Its data will be deleted too.')
            ->visible(fn (): bool => Builder::editable())
            ->action(fn (array $record, Action $action) => $this->save(
                $action,
                fn (array $ir): array => ModelSchema::deleteField($ir, (string) $this->type, $record['name']),
            ));
    }

    /**
     * Strapi's field dialog: the field's kind (its cards), then Basic and Advanced settings.
     *
     * @return list<\Filament\Schemas\Components\Component|\Filament\Forms\Components\Field>
     */
    private function fieldSchema(bool $adding): array
    {
        $ir = $this->document();
        $inComponent = str_starts_with((string) $this->type, 'component:');
        $kinds = array_filter(ModelSchema::FIELD_KINDS, fn (string $kind): bool => ! ($inComponent && $kind === 'dynamicZone'), ARRAY_FILTER_USE_KEY);
        $is = fn (string ...$kinds): \Closure => fn (Get $get): bool => in_array($get('kind'), $kinds, true);
        $contentTypes = [];
        foreach ($ir['contentTypes'] as $type) {
            $contentTypes[$type['name']] = ModelSchema::displayName($type);
        }
        $components = [];
        foreach ($ir['components'] as $component) {
            $components[$component['name']] = ModelSchema::componentUid($component);
        }
        $textFields = [];
        foreach ((array) ($this->node()['fields'] ?? []) as $field) {
            if (in_array($field['type'], ['string', 'text'], true)) {
                $textFields[$field['name']] = $field['name'];
            }
        }

        return [
            Radio::make('kind')->label('Select a field')->required()->live()
                ->options(array_map(fn (array $kind): string => $kind['label'], $kinds))
                ->descriptions(array_map(fn (array $kind): string => $kind['description'], $kinds))
                ->columns(2)
                ->disabled(! $adding)
                ->dehydrated(),
            Tabs::make()->visible(fn (Get $get): bool => $get('kind') !== null)->tabs([
                Tab::make('Basic settings')->schema([
                    TextInput::make('name')->label('Name')->required()->regex(ModelSchema::FIELD_NAME)
                        ->helperText('camelCase: a lowercase letter, then letters and digits. Renaming a field deletes its data.'),
                    Radio::make('textType')->label('Type')->visible($is('text'))->default('string')
                        ->options(['string' => 'Short text', 'text' => 'Long text'])
                        ->descriptions(['string' => 'Best for titles, names, links (URL)', 'text' => 'Best for descriptions, biography']),
                    Select::make('numberType')->label('Number format')->visible($is('number'))->required($is('number'))
                        ->options(['integer' => 'integer (ex: 10)', 'bigInteger' => 'big integer (ex: 123456789)', 'decimal' => 'decimal (ex: 2.22)', 'float' => 'float (ex: 3.3333333)']),
                    Select::make('dateType')->label('Type')->visible($is('date'))->required($is('date'))
                        ->options(['date' => 'date (ex: 01/01/2024)', 'dateTime' => 'datetime (ex: 01/01/2024 00:00 AM)', 'time' => 'time (ex: 00:00 AM)', 'timestamp' => 'timestamp']),
                    Toggle::make('multiple')->label('Multiple media')->visible($is('media')),
                    Select::make('relationKind')->label('Relation')->visible($is('relation'))->required($is('relation'))
                        ->options(array_map(fn (string $label): string => ucfirst($label), ModelSchema::RELATION_KINDS)),
                    Select::make('target')->label('Content type')->visible($is('relation'))->required($is('relation'))->options($contentTypes),
                    TextInput::make('inverse')->label('Field name on the other content type')->visible($is('relation'))
                        ->regex(ModelSchema::FIELD_NAME)->helperText('Leave empty for a one-way relation.'),
                    Textarea::make('values')->label('Values (one line per value)')->visible($is('enumeration'))->required($is('enumeration'))->rows(4),
                    Select::make('targetField')->label('Attached field')->visible($is('uid'))->options($textFields),
                    Select::make('component')->label('Component')->visible($is('component'))->required($is('component'))->options($components),
                    Radio::make('repeatable')->label('Type')->visible($is('component'))->boolean('Repeatable component', 'Single component')->default(false),
                    CheckboxList::make('components')->label('Components')->visible($is('dynamicZone'))->required($is('dynamicZone'))->options($components),
                ]),
                Tab::make('Advanced settings')->schema([
                    TextInput::make('default')->label('Default value')
                        ->visible($is('text', 'richText', 'email', 'uid', 'enumeration', 'number', 'date', 'color')),
                    Select::make('default')->label('Default value')->visible($is('boolean'))
                        ->options(['true' => 'TRUE', 'false' => 'FALSE']),
                    TextInput::make('pattern')->label('RegExp pattern')->visible($is('text', 'richText', 'uid', 'color')),
                    Toggle::make('required')->label('Required field')->helperText('You won\'t be able to create an entry if this field is empty'),
                    Toggle::make('unique')->label('Unique field')->visible($is('text', 'richText', 'email', 'uid', 'number'))
                        ->helperText('You won\'t be able to create an entry if there is an existing entry with identical content'),
                    Toggle::make('private')->label('Private field')->helperText('This field will not show up in the API response'),
                    TextInput::make('minLength')->label('Minimum length')->numeric()->visible($is('text', 'richText', 'email', 'uid')),
                    TextInput::make('maxLength')->label('Maximum length')->numeric()->visible($is('text', 'richText', 'email', 'uid')),
                    TextInput::make('min')->label('Minimum value')->numeric()->visible($is('number')),
                    TextInput::make('max')->label('Maximum value')->numeric()->visible($is('number')),
                    CheckboxList::make('allowedTypes')->label('Select allowed types of media')->visible($is('media'))
                        ->options(['image' => 'Images (JPEG, PNG, GIF, SVG, TIFF, ICO, DVU)', 'video' => 'Videos (MPEG, MP4, Quicktime, WMV, AVI, FLV)', 'audio' => 'Audios (MP3, WAV, OGG)', 'file' => 'Files (CSV, ZIP, PDF, Excel, JSON, ...)']),
                ]),
            ]),
        ];
    }

    // ---- saving --------------------------------------------------------------------------------

    /**
     * Apply an edit: write the IR, rebuild, sync the database, then reload the page on the type
     * the edit leaves on show, as Strapi reloads its admin after a save. A refused edit or a failed
     * build keeps the dialog open with the reason.
     *
     * @param  callable(array<string, mixed>): array<string, mixed>  $change
     * @param  (callable(array<string, mixed>): string)|null  $touched  the content type to grant the super-admin
     * @param  (callable(array<string, mixed>): ?string)|null  $next  the type to show after the save
     */
    private function save(Action $action, callable $change, ?callable $touched = null, ?callable $next = null): void
    {
        try {
            $after = Builder::apply($change, $touched);
        } catch (\InvalidArgumentException|RuntimeException $exception) {
            Notification::make()->danger()->title('Not saved')->body(nl2br(e(mb_strimwidth($exception->getMessage(), 0, 2000, '…'))))->persistent()->send();
            $action->halt();

            return;
        }
        Notification::make()->success()->title('Saved')->body('The content model was updated and the app rebuilt.')->send();
        $type = $next === null ? $this->type : $next($after);
        $this->redirect(static::getUrl($type === null ? [] : ['type' => $type]));
    }

    // ---- reading -------------------------------------------------------------------------------

    /** @return array<string, mixed> */
    private function document(): array
    {
        return $this->document ??= Builder::document();
    }

    /** @return array<string, mixed>|null */
    private function node(): ?array
    {
        return $this->type === null ? null : ModelSchema::find($this->document(), $this->type);
    }

    /** @return array<string, mixed> */
    private function field(string $name): array
    {
        foreach ((array) ($this->node()['fields'] ?? []) as $field) {
            if ($field['name'] === $name) {
                return $field;
            }
        }
        throw new RuntimeException("no field named \"{$name}\"");
    }

    /** @return array<string, array{name: string, type: string, details: string}> */
    private function fieldRows(): array
    {
        $rows = [];
        foreach ((array) ($this->node()['fields'] ?? []) as $field) {
            $rows[$field['name']] = ModelSchema::fieldRow($field, $this->document());
        }

        return $rows;
    }

    private function firstType(): ?string
    {
        $navigation = ModelSchema::navigation($this->document());
        foreach (['collectionTypes', 'singleTypes'] as $list) {
            if ($navigation[$list] !== []) {
                return ModelSchema::ref('contentType', $navigation[$list][0]['name']);
            }
        }
        foreach ($navigation['components'] as $components) {
            return ModelSchema::ref('component', $components[0]['name']);
        }

        return null;
    }

    /** @param array<string, mixed> $type */
    private function contentTypeUid(array $type): string
    {
        $name = ModelSchema::kebab((string) $type['name']);

        return match ($type['builtin'] ?? null) {
            'user' => 'plugin::users-permissions.user',
            default => "api::{$name}.{$name}",
        };
    }
}
`;
