<?php

declare(strict_types=1);

namespace App\Filament\Resources\Ledgers\Schemas;

use Filament\Forms\Components\Repeater;
use Filament\Forms\Components\TextInput;
use Filament\Schemas\Schema;

class LedgerForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('label'),
            TextInput::make('balance')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(20, 6)),
            TextInput::make('rate')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(9, 4)),
            TextInput::make('share')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(15, 5)),
            TextInput::make('units')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(14, 4)),
            TextInput::make('fee')->numeric(),
            TextInput::make('lines'),
            TextInput::make('limit_ceiling')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(18, 2)),
            Repeater::make('entries')->relationship()->schema([
                TextInput::make('memo'),
                TextInput::make('amount')->inputMode('decimal')->rule(new \App\Rules\DecimalDigitsRule(20, 6)),
            ]),
        ]);
    }
}
