<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Entry extends Model
{
    protected $table = 'entries';

    protected $fillable = [
        'title',
        'code',
        'headline',
        'abstract',
        'contact',
        'slug',
        'handle',
        'unbounded',
        'label',
        'tagline',
        'summary',
    ];

    protected $attributes = [
        'tagline' => 'hello',
        'summary' => 'none',
    ];
}
