<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Observers\ArticleObserver;

#[\Illuminate\Database\Eloquent\Attributes\ObservedBy([ArticleObserver::class])]
class Article extends Model
{
    protected $table = 'articles';

    protected $fillable = [
        'title',
        'published_at',
    ];

    protected function casts(): array
    {
        return [
            'published_at' => 'datetime',
        ];
    }
}
