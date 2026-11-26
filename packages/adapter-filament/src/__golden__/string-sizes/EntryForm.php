<?php

declare(strict_types=1);

namespace App\Filament\Resources\Entries\Schemas;

use Filament\Forms\Components\TextInput;
use Filament\Schemas\Schema;

class EntryForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('title'),
            TextInput::make('code')->rule('max:40'),
            TextInput::make('headline')->rule('max:1000'),
            TextInput::make('abstract')->rule('max:20000'),
            TextInput::make('contact')->email()->rule('max:320'),
            TextInput::make('slug')->unique()->rule('max:300'),
            TextInput::make('handle')->unique()->rule('max:673'),
            TextInput::make('unbounded')->rule('max:1073741824'),
        ]);
    }
}
