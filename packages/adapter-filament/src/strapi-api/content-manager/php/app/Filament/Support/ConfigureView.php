<?php

declare(strict_types=1);

namespace App\Filament\Support;

use App\Support\StrapiContentManager;
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
                Repeater::make('list')->hiddenLabel()->reorderable()->addActionLabel('Add a field')->columns(3)->schema([
                    Select::make('name')->label('Field')->options($listable)->distinct()->required(),
                    TextInput::make('label')->required(),
                    Toggle::make('sortable')->label('Enable sort on this field'),
                ]),
            ]),
            Section::make('Edit view')->schema([
                Repeater::make('edit')->hiddenLabel()->reorderable()->addable(false)->deletable(false)->columns(3)
                    ->itemLabel(fn (array $state): string => (string) ($state['name'] ?? ''))
                    ->schema([
                        Hidden::make('name'),
                        Toggle::make('shown')->label('Show in the edit view'),
                        Toggle::make('editable')->label('Editable field'),
                        Select::make('size')->options(fn (Get $get): array => StrapiContentManager::sizes($view['attributes'][$get('name')] ?? ['resizable' => true, 'size' => 6]))->required(),
                        TextInput::make('label')->required(),
                        TextInput::make('description'),
                        TextInput::make('placeholder'),
                    ]),
            ]),
        ])->statePath('data');
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
