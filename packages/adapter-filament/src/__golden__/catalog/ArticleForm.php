<?php

declare(strict_types=1);

namespace App\Filament\Resources\Articles\Schemas;

use App\Filament\Forms\JsonEditor;
use Filament\Forms\Components\DateTimePicker;
use Filament\Forms\Components\FileUpload;
use Filament\Forms\Components\MarkdownEditor;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Schemas\Schema;

class ArticleForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('title')->required(),
            MarkdownEditor::make('body'),
            Select::make('status')->options(['draft' => 'draft', 'published' => 'published']),
            JsonEditor::make('meta'),
            FileUpload::make('cover'),
            DateTimePicker::make('published_at'),
            Select::make('author_id')->relationship(name: 'author', titleAttribute: 'name'),
            Select::make('tags')->multiple()->relationship(name: 'tags', titleAttribute: 'label'),
        ]);
    }
}
