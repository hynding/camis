<?php

declare(strict_types=1);

namespace App\Filament\Resources\Ledgers\Schemas;

use App\Filament\Resources\Ledgers\LedgerResource;
use App\Http\Serializers\LedgerSerializer;
use App\Support\StrapiContentManager;
use App\Support\StrapiZones;
use Filament\Forms\Components\Builder;
use Filament\Forms\Components\Builder\Block;
use Filament\Forms\Components\Repeater;
use Filament\Forms\Components\TextInput;
use Filament\Schemas\Schema;
use Illuminate\Database\Eloquent\Model;

class LedgerForm
{
    public static function configure(Schema $schema): Schema
    {
        return StrapiContentManager::form($schema, LedgerResource::CONTENT_MANAGER, [
            'label' => [
                TextInput::make('label'),
            ],
            'balance' => [
                TextInput::make('balance')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(20, 6)),
            ],
            'rate' => [
                TextInput::make('rate')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(9, 4)),
            ],
            'share' => [
                TextInput::make('share')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(15, 5))->rule(fn (?string $model, ?\Illuminate\Database\Eloquent\Model $record) => new \App\Rules\DecimalDigitsUniqueRule($model, 'share', 15, 5, $record)),
            ],
            'units' => [
                TextInput::make('units')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(14, 4)),
            ],
            'fee' => [
                TextInput::make('fee')->numeric(),
            ],
            'limit' => StrapiContentManager::component('shared.limit', [
                'ceiling' => [
                    TextInput::make('limit_ceiling')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(18, 2)),
                ],
            ]),
            'entries' => [
                Repeater::make('entries')->relationship()->schema(StrapiContentManager::component('shared.entry', [
                    'memo' => [
                        TextInput::make('memo'),
                    ],
                    'amount' => [
                        TextInput::make('amount')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(20, 6)),
                    ],
                ])),
            ],
            'lines' => [
                Builder::make('lines')
                    ->blocks([
                        Block::make('shared.limit')->label(fn (?array $state): string => StrapiContentManager::blockLabel('shared.limit', 'Limit', $state))->schema(StrapiContentManager::component('shared.limit', [
                            'ceiling' => [
                                TextInput::make('ceiling')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(18, 2)),
                            ],
                        ])),
                    ])
                    ->blockNumbers(false)
                    ->afterStateHydrated(fn (Builder $component, ?Model $record) => $component->state(StrapiZones::builder($record, LedgerSerializer::ZONES['lines'])))
                    ->dehydrated(false)
                    ->saveRelationshipsUsing(fn (Model $record, ?array $state) => StrapiZones::sync($record, 'lines', LedgerSerializer::ZONES['lines'], StrapiZones::fromBuilder($state, LedgerSerializer::ZONES['lines']))),
            ],
        ]);
    }
}
