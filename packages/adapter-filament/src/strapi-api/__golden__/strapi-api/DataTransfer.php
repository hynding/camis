<?php

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Support\StrapiExport;
use App\Support\StrapiImport;
use App\Support\StrapiTransferArchives;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Forms\Components\CheckboxList;
use Filament\Forms\Components\FileUpload;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Notifications\Notification;
use Filament\Pages\Page;
use Filament\Schemas\Components\Actions;
use Filament\Schemas\Components\EmbeddedSchema;
use Filament\Schemas\Components\Form;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;
use Illuminate\Support\Facades\URL;
use UnitEnum;

/** Strapi's `strapi export` and `strapi import` from the admin, for a host with no shell. */
class DataTransfer extends Page
{
    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-arrow-path-rounded-square';

    protected static string | UnitEnum | null $navigationGroup = 'Settings';

    protected static ?string $navigationLabel = 'Data transfer';

    protected static ?string $title = 'Data transfer';

    private const TYPES = ['content' => 'Content', 'files' => 'Files', 'config' => 'Settings'];

    public ?array $exportData = [];

    public ?array $importData = [];

    public static function canAccess(): bool
    {
        return auth()->user()?->can('user.update') ?? false;
    }

    public function mount(): void
    {
        $this->exportForm->fill(['encrypt' => true, 'compress' => true, 'exclude' => []]);
        $this->importForm->fill(['exclude' => []]);
    }

    public function exportForm(Schema $schema): Schema
    {
        return $schema->components([
            Toggle::make('encrypt')->label('Encrypt (aes-128-ecb)')->live(),
            TextInput::make('key')->label('Encryption key')->password()->revealable()
                ->visible(fn ($get): bool => (bool) $get('encrypt'))
                ->required(fn ($get): bool => (bool) $get('encrypt')),
            Toggle::make('compress')->label('Compress (gzip)'),
            CheckboxList::make('exclude')->label('Leave out')->options(self::TYPES)->columns(3),
        ])->statePath('exportData');
    }

    public function importForm(Schema $schema): Schema
    {
        return $schema->components([
            FileUpload::make('upload')->label('Archive')
                ->disk('local')->directory('strapi-transfer')->preserveFilenames()
                ->helperText('A .tar, .tar.gz or .tar.gz.enc file from strapi export. One larger than this host takes in an upload goes in storage/app/private/strapi-transfer by FTP, to be picked below.'),
            Select::make('stored')->label('Or an archive already on the server')
                ->options(fn (): array => array_combine(StrapiTransferArchives::names(), StrapiTransferArchives::names()) ?: []),
            TextInput::make('key')->label('Decryption key')->password()->revealable()
                ->helperText('For an encrypted archive only.'),
            CheckboxList::make('exclude')->label('Leave out')->options(self::TYPES)->columns(3),
        ])->statePath('importData');
    }

    public function content(Schema $schema): Schema
    {
        return $schema->components([
            Section::make('Export')
                ->description('Writes the archive strapi import reads into a Strapi project built from the same schema.')
                ->schema([
                    Form::make([EmbeddedSchema::make('exportForm')])
                        ->id('exportForm')
                        ->livewireSubmitHandler('export')
                        ->footer([Actions::make([Action::make('export')->submit('export')])]),
                ]),
            Section::make('Import')
                ->description('Replaces this project\'s content, files and settings with an archive from strapi export.')
                ->schema([
                    EmbeddedSchema::make('importForm'),
                    Actions::make([$this->importAction()]),
                ]),
        ]);
    }

    public function export(): void
    {
        $state = $this->exportForm->getState();
        StrapiTransferArchives::unlimited();
        try {
            $written = StrapiExport::write(
                StrapiTransferArchives::directory().DIRECTORY_SEPARATOR.'export_'.now()->format('YmdHis'),
                StrapiExport::stages(null, $state['exclude'] === [] ? null : array_values($state['exclude'])),
                (bool) $state['compress'],
                $state['encrypt'] ? (string) $state['key'] : null,
            );
        } catch (\Throwable $error) {
            Notification::make()->danger()->title('Export process failed')->body($error->getMessage())->send();

            return;
        }
        Notification::make()->success()->title('Export process has been completed successfully!')
            ->body(self::summary($written['counts']))->send();
        $this->redirect(URL::temporarySignedRoute('camis.data-transfer.download', now()->addMinutes(10), ['file' => basename($written['path'])]));
    }

    public function importAction(): Action
    {
        return Action::make('import')->color('danger')
            ->requiresConfirmation()
            ->modalDescription('The import will delete your existing data! Are you sure you want to proceed?')
            ->action(fn () => $this->import());
    }

    private function import(): void
    {
        $state = $this->importForm->getState();
        $uploaded = $state['upload'] ?? null;
        $name = filled($uploaded) ? basename((string) $uploaded) : ($state['stored'] ?? null);
        if (blank($name)) {
            Notification::make()->danger()->title('Choose an archive to import')->send();

            return;
        }
        StrapiTransferArchives::unlimited();
        try {
            $import = StrapiImport::open(StrapiTransferArchives::path((string) $name), filled($state['key'] ?? null) ? (string) $state['key'] : null);
            $diffs = $import->schemaDiffs();
            if ($diffs !== []) {
                Notification::make()->danger()->persistent()->title('The source and destination provide incompatible schemas')
                    ->body(implode("\n", $diffs))->send();

                return;
            }
            $counts = $import->run(StrapiImport::stages(null, $state['exclude'] === [] ? null : array_values($state['exclude'])));
        } catch (\Throwable $error) {
            Notification::make()->danger()->title('Import process failed')->body($error->getMessage())->send();

            return;
        } finally {
            if (filled($uploaded)) {
                @unlink(StrapiTransferArchives::path(basename((string) $uploaded)));
            }
        }
        $skipped = array_map(fn ($type, $reason) => "Not imported: {$type} ({$reason})", array_keys($import->skipped()), $import->skipped());
        Notification::make()->success()->persistent()->title('Import process has been completed successfully!')
            ->body(implode("\n", [self::summary($counts), ...$skipped]))->send();
        $this->importForm->fill(['exclude' => []]);
    }

    /** @param array<string, int> $counts */
    private static function summary(array $counts): string
    {
        return implode(', ', array_map(fn ($type, $count) => "{$type}: {$count}", array_keys($counts), $counts));
    }
}
