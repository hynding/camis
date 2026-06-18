<?php

declare(strict_types=1);

namespace App\Filament\Resources\Articles\Schemas;

use Filament\Tables\Columns\IconColumn;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

class ArticlesTable
{
    public static function configure(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('title'),
            TextColumn::make('body'),
            IconColumn::make('published')->boolean(),
            TextColumn::make('published_at')->dateTime(),
        ]);
    }
}
