import { navigationProperties, SETTINGS } from "../admin/admin-navigation";

export const MEDIA_LIBRARY_SETTINGS_PAGE_PATH = "app/Filament/Pages/MediaLibrarySettings.php";

const toggle = (key: string, label: string, help: string): string => `
                Toggle::make('${key}')->label('${label}')
                    ->helperText('${help}'),`;

/** Strapi's Settings › Media Library: its upload settings, kept in the store, as Strapi keeps them. */
export const emitMediaLibrarySettingsPage = (secured: boolean): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Pages;

use App\\Filament\\StrapiNavigation;
use App\\Support\\StrapiSettings;
use App\\Support\\StrapiUpload;
use BackedEnum;
use Filament\\Actions\\Action;
use Filament\\Forms\\Components\\Toggle;
use Filament\\Notifications\\Notification;
use Filament\\Pages\\Page;
use Filament\\Schemas\\Components\\Actions;
use Filament\\Schemas\\Components\\EmbeddedSchema;
use Filament\\Schemas\\Components\\Form;
use Filament\\Schemas\\Components\\Section;
use Filament\\Schemas\\Schema;
use UnitEnum;

class MediaLibrarySettings extends Page
{
    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-photo';
${navigationProperties(SETTINGS.mediaLibrary)}
    protected static ?string $title = 'Media Library';

    protected ?string $subheading = 'Configure the settings for the Media Library';

    public ?array $data = [];

    public static function canAccess(): bool
    {
        return ${secured ? "auth()->user()?->can('user.update') ?? false" : "true"};
    }

    public function mount(): void
    {
        $this->form->fill(['settings' => StrapiUpload::settings()]);
    }

    public function form(Schema $schema): Schema
    {
        return $schema->components([
            Section::make('Asset management')->statePath('settings')->schema([${toggle(
              "responsiveDimensions",
              "Responsive friendly upload",
              "Enabling this option will generate multiple formats (small, medium and large) of the uploaded asset.",
            )}${toggle(
              "sizeOptimization",
              "Size optimization",
              "Enabling this option will reduce the image size and slightly reduce its quality.",
            )}${toggle(
              "autoOrientation",
              "Auto orientation",
              "Enabling this option will automatically rotate the image according to EXIF orientation tag.",
            )}
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

    /** Only the three toggles change; the rest of Strapi's settings (aiMetadata) are kept. */
    public function save(): void
    {
        $state = $this->form->getState();
        StrapiSettings::merge(StrapiUpload::SETTINGS_KEY, $state['settings']);
        Notification::make()->success()->title('Saved')->send();
    }
}
`;
