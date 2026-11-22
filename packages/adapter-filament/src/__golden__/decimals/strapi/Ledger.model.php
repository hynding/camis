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
use Illuminate\Database\Eloquent\Relations\HasMany;

class Ledger extends Model
{
    use EmitsStrapiEvents;

    use HasDocumentId;

    use HasCreatorFields;

    use HasMillisecondTimestamps;

    protected $table = 'ledgers';

    protected $fillable = [
        'label',
        'balance',
        'rate',
        'share',
        'units',
        'fee',
        'limit_ceiling',
    ];

    protected function casts(): array
    {
        return [
            'balance' => 'decimal:6',
            'rate' => 'decimal:4',
            'share' => 'decimal:5',
            'units' => 'decimal:4',
            'fee' => 'decimal:2',
            'limit_ceiling' => 'decimal:2',
        ];
    }

    public function entries(): HasMany
    {
        return $this->hasMany(LedgerEntries::class, 'ledger_id')->orderBy('id');
    }

    /** Rows visible to $user (Strapi API style list scope): each role's read condition, in SQL. */
    public function scopeForUser(Builder $q, ?User $user): Builder
    {
        return $q;
    }
}
