<?php

declare(strict_types=1);

namespace App\Filament\Support;

use App\Filament\Pages\ConfigureComponentView;
use App\Support\StrapiComponentViews;
use App\Support\StrapiContentManager;
use Closure;
use Filament\Actions\Action;
use Filament\Forms\Components\Hidden;
use Filament\Forms\Components\Repeater;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\Page;
use Filament\Schemas\Components\Actions;
use Filament\Schemas\Components\EmbeddedSchema;
use Filament\Schemas\Components\Form;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Components\Utilities\Get;
use Filament\Schemas\Components\Utilities\Set;
use Filament\Schemas\Schema;

abstract class ConfigureView extends Page
{
    protected static ?string $title = 'Configure the view';

    public ?array $data = [];

    public static function canAccess(array $parameters = []): bool
    {
        return static::getResource()::canConfigureView();
    }

    protected static function view(): array
    {
        return static::getResource()::CONTENT_MANAGER;
    }

    public function mount(): void
    {
        abort_unless(static::canAccess(), 403);
        $this->form->fill(StrapiContentManager::formState(static::view()));
    }

    public function form(Schema $schema): Schema
    {
        $view = static::view();
        $sortable = array_combine(StrapiContentManager::sortable($view), StrapiContentManager::sortable($view));
        $listable = array_combine(StrapiContentManager::listable($view), StrapiContentManager::listable($view));

        return $schema->components([
            Section::make('Settings')->statePath('settings')->columns(2)->schema([
                Toggle::make('searchable')->label('Enable search'),
                Toggle::make('filterable')->label('Enable filters'),
                Toggle::make('bulkable')->label('Enable bulk actions'),
                Select::make('pageSize')->label('Entries per page')->options(array_combine(StrapiContentManager::PAGE_SIZES, StrapiContentManager::PAGE_SIZES))->required(),
                Select::make('mainField')->label('Entry title')->options($sortable)->required(),
                Select::make('defaultSortBy')->label('Default sort attribute')->options($sortable)->required(),
                Select::make('defaultSortOrder')->label('Default sort order')->options(['ASC' => 'Ascending', 'DESC' => 'Descending'])->required(),
            ]),
            Section::make('List view')->schema([
                Repeater::make('list')->hiddenLabel()->reorderable()->addActionLabel('Add a field')->columns(4)->schema([
                    Select::make('name')->label('Field')->options($listable)->distinct()->required()->live()
                        // Another field's entry title is its target's, from its default.
                        ->afterStateUpdated(fn (Set $set, ?string $state) => $set('mainField', $view['attributes'][$state]['mainField'] ?? null)),
                    TextInput::make('label')->required(),
                    Toggle::make('sortable')->label('Enable sort on this field'),
                    self::mainFieldSelect($view),
                ]),
            ]),
            self::editSection($view),
        ])->statePath('data');
    }

    /**
     * The edit view's fields, each shown or not, sized, labelled, described and locked, and a
     * relation's entries titled by one of its target's fields; a component's links to its own view.
     */
    public static function editSection(array $view): Section
    {
        return Section::make('Edit view')->schema([
            Repeater::make('edit')->hiddenLabel()->reorderable()->addable(false)->deletable(false)->columns(3)
                ->itemLabel(fn (array $state): string => (string) ($state['name'] ?? ''))
                ->extraItemActions([
                    Action::make('configureComponent')
                        ->label('Configure the component')
                        ->icon('heroicon-m-cog-6-tooth')
                        ->url(fn (array $arguments, Repeater $component): ?string => self::componentViewUrl($view, $component->getRawItemState($arguments['item'])['name'] ?? null))
                        ->visible(fn (array $arguments, Repeater $component): bool => self::componentViewUrl($view, $component->getRawItemState($arguments['item'])['name'] ?? null) !== null),
                ])
                ->schema([
                    Hidden::make('name'),
                    Toggle::make('shown')->label('Show in the edit view'),
                    Toggle::make('editable')->label('Editable field'),
                    Select::make('size')->options(fn (Get $get): array => StrapiContentManager::sizes($view['attributes'][$get('name')] ?? ['resizable' => true, 'size' => 6]))->required()
                        ->visible(self::offers($view, 'size')),
                    TextInput::make('label')->required(),
                    TextInput::make('description')->visible(self::offers($view, 'description')),
                    TextInput::make('placeholder')->visible(self::offers($view, 'placeholder')),
                    self::mainFieldSelect($view),
                ]),
        ]);
    }

    /** Whether an edit view's field may set this, as Strapi offers it for the field's type. */
    private static function offers(array $view, string $setting): Closure
    {
        return fn (Get $get): bool => in_array($setting, StrapiContentManager::editSettings((string) ($view['attributes'][(string) $get('name')]['type'] ?? '')), true);
    }

    /** A relation's entry title: one of the fields of its target that Strapi lets title an entry. */
    private static function mainFieldSelect(array $view): Select
    {
        $titled = fn (Get $get): bool => isset($view['attributes'][(string) $get('name')]['mainFields']);

        return Select::make('mainField')->label('Entry title')
            ->options(fn (Get $get): array => StrapiContentManager::mainFieldOptions($view, (string) $get('name')))
            ->visible($titled)
            ->required($titled);
    }

    /** Where a component attribute's own view is configured, for who may; null for another attribute. */
    private static function componentViewUrl(array $view, mixed $name): ?string
    {
        $component = is_string($name) ? ($view['attributes'][$name]['component'] ?? null) : null;
        if ($component === null || ! isset(StrapiComponentViews::VIEWS[$component]) || ! StrapiComponentViews::canConfigure()) {
            return null;
        }

        return ConfigureComponentView::getUrl(['component' => $component]);
    }

    public function content(Schema $schema): Schema
    {
        return $schema->components([
            Form::make([EmbeddedSchema::make('form')])
                ->id('form')
                ->livewireSubmitHandler('save')
                ->footer([Actions::make([Action::make('save')->submit('save')])]),
        ]);
    }

    public function save(): void
    {
        abort_unless(static::canAccess(), 403);
        $view = static::view();
        StrapiContentManager::save($view, StrapiContentManager::fromFormState($view, $this->form->getState()));
        // The list remembers its shown columns per session; the saved layout replaces this user's.
        // (Filament's session key for a list's columns: its page class hashed.)
        $list = hash('sha256', static::getResource()::getPages()['index']->getPage());
        session()->forget(["filament.tables.{$list}.columns", "filament.tables.{$list}.has_reordered_columns"]);
        Notification::make()->success()->title('Saved')->send();
        $this->redirect(static::getResource()::getUrl());
    }
}
