<?php

declare(strict_types=1);

namespace App\Filament\Resources\AdminTokens\Pages;

use App\Filament\Resources\AdminTokens\AdminTokenResource;
use App\Models\AdminUser;
use App\Support\StrapiAdminTokens;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Database\Eloquent\Model;

class CreateAdminToken extends CreateRecord
{
    protected static string $resource = AdminTokenResource::class;

    protected function handleRecordCreation(array $data): Model
    {
        $owner = auth()->user();
        abort_unless($owner instanceof AdminUser, 403);
        // The duration select hands its option back as a string.
        $made = StrapiAdminTokens::create($owner, [
            'name' => (string) $data['name'],
            'description' => is_string($data['description'] ?? null) ? $data['description'] : '',
            'lifespan' => filled($data['lifespan'] ?? null) ? (int) $data['lifespan'] : null,
            'admin_permissions' => array_values($data['admin_permissions'] ?? []),
        ]);
        $this->showKey($made['accessKey']);

        return $made['token'];
    }

    protected function getRedirectUrl(): string
    {
        return $this->getResource()::getUrl('edit', ['record' => $this->getRecord()]);
    }

    private function showKey(string $key): void
    {
        Notification::make()->success()->persistent()
            ->title('Copy your admin token')
            ->body($key)
            ->send();
    }
}
