<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Models\Concerns\EmitsStrapiEvents;
use App\Models\Concerns\HasCreatorFields;
use App\Models\Concerns\HasDocumentId;
use App\Models\Concerns\HasMillisecondTimestamps;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Note extends Model
{
    use EmitsStrapiEvents;

    use HasDocumentId;

    use HasCreatorFields;

    use HasMillisecondTimestamps;

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

    /** Rows visible to $user (Strapi API style list scope): each role's read condition, in SQL. */
    public function scopeForUser(Builder $q, ?User $user): Builder
    {
        if (\App\Support\StrapiApiTokens::active()) {
            return $q;
        }

        return $q->where(function (Builder $q) use ($user): void {
            $q->whereRaw('1 = 0');
            if ($user !== null && $user->hasAnyRole(['authenticated'])) {
                $q->orWhere(function (Builder $q) use ($user): void {
                    $q->where('owner_id', '=', $user->id);
                });
            }
        });
    }
}
