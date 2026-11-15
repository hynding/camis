<?php

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Filament\Support\ConfigureView;
use App\Support\StrapiComponentViews;
use App\Support\StrapiContentManager;
use Filament\Actions\Action;
use Filament\Notifications\Notification;
use Filament\Pages\Page;
use Filament\Schemas\Components\Actions;
use Filament\Schemas\Components\EmbeddedSchema;
use Filament\Schemas\Components\Form;
use Filament\Schemas\Components\Section;
use Filament\Forms\Components\Select;
use Filament\Schemas\Schema;
use Livewire\Attributes\Locked;

/**
 * Strapi's "Configure the view" for a component (its components::<uid> configuration): the entry
 * title, and the edit view every use of the component is laid out by. Opened from the view of a
 * type that uses it; not in the navigation.
 */
class ConfigureComponentView extends Page
{
    protected static ?string $slug = 'content-manager/components/configure';

    protected static bool $shouldRegisterNavigation = false;

    #[Locked]
    public string $component = '';

    public ?array $data = [];

    public static function canAccess(): bool
    {
        return StrapiComponentViews::canConfigure();
    }

    public function getTitle(): string
    {
        return 'Configure the view of '.$this->component;
    }

    public function mount(): void
    {
        abort_unless(static::canAccess(), 403);
        $this->component = (string) request()->query('component', $this->component);
        abort_unless(isset(StrapiComponentViews::VIEWS[$this->component]), 404);
        $state = StrapiContentManager::formState($this->view());
        unset($state['list']);
        $this->form->fill($state);
    }

    private function view(): array
    {
        return StrapiComponentViews::VIEWS[$this->component];
    }

    public function form(Schema $schema): Schema
    {
        $view = $this->view();
        $sortable = StrapiContentManager::sortable($view);

        return $schema->components([
            Section::make('Settings')->statePath('settings')->schema([
                Select::make('mainField')->label('Entry title')->options(array_combine($sortable, $sortable))->required(),
            ]),
            ConfigureView::editSection($view),
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
        $view = $this->view();
        StrapiContentManager::save($view, StrapiContentManager::fromFormState($view, $this->form->getState()));
        Notification::make()->success()->title('Saved')->send();
    }
}
