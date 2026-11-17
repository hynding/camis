<?php

declare(strict_types=1);

namespace App\Filament\Resources\AdminTokens\Pages;

use App\Filament\Resources\AdminTokens\AdminTokenResource;
use App\Models\AdminUser;
use App\Models\StrapiAdminToken;
use App\Support\StrapiAdminTokens;
use Filament\Actions\Action;
use Filament\Actions\DeleteAction;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\EditRecord;

/** @property StrapiAdminToken $record */
class EditAdminToken extends EditRecord
{
    protected static string $resource = AdminTokenResource::class;

    protected function getHeaderActions(): array
    {
        // Only the owner sees the key or makes a new one: Strapi's super-admin does not.
        $owns = fn (): bool => (int) $this->record->admin_user_owner_id === (int) auth()->id();

        return [
            Action::make('view')->label('View token')
                ->visible(fn (): bool => $owns() && $this->record->encrypted_key !== null)
                ->action(fn () => $this->showKey(StrapiAdminTokens::reveal($this->record) ?? 'This token can no longer be shown: regenerate it.')),
            Action::make('regenerate')
                ->visible($owns)
                ->requiresConfirmation()
                ->modalDescription('Requests sent with the current key will be refused.')
                ->action(fn () => $this->showKey(StrapiAdminTokens::regenerate($this->record))),
            DeleteAction::make(),
        ];
    }

    /** The owner's ceiling holds whoever saves the token. */
    protected function mutateFormDataBeforeSave(array $data): array
    {
        $owner = $this->record->owner;

        return [...$data, 'admin_permissions' => $owner instanceof AdminUser ? StrapiAdminTokens::clamp($owner, array_values($data['admin_permissions'] ?? [])) : []];
    }

    private function showKey(string $key): void
    {
        Notification::make()->success()->persistent()
            ->title('Copy your admin token')
            ->body($key)
            ->send();
    }
}
