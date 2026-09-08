<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Note extends Model
{
    protected $table = 'notes';

    protected $fillable = [
        'record_id',
        'text',
        'tags',
        'occurred_at',
        'owner_id',
    ];

    protected function casts(): array
    {
        return [
            'tags' => 'array',
            'occurred_at' => 'datetime',
        ];
    }

    public function owner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'owner_id');
    }

    /** Rows visible to $user (Strapi API style list scope). */
    public function scopeForUser(Builder $q, User $user): Builder
    {
        $q->where('owner_id', '=', $user->id);

        return $q;
    }
}
