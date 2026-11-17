<?php

declare(strict_types=1);

namespace App\Filament\Resources\AdminTokens\Pages;

use App\Filament\Resources\AdminTokens\AdminTokenResource;
use Filament\Actions\CreateAction;
use Filament\Resources\Pages\ListRecords;

class ListAdminTokens extends ListRecords
{
    protected static string $resource = AdminTokenResource::class;

    protected function getHeaderActions(): array
    {
        return [
            CreateAction::make()->label('Create new Admin Token'),
        ];
    }
}
