<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Ledger extends Model
{
    protected $table = 'ledgers';

    protected $fillable = [
        'label',
        'balance',
        'rate',
        'fee',
        'limit_ceiling',
    ];

    protected function casts(): array
    {
        return [
            'balance' => 'decimal:6',
            'rate' => 'decimal:4',
            'fee' => 'decimal:2',
            'limit_ceiling' => 'decimal:2',
        ];
    }

    public function entries(): HasMany
    {
        return $this->hasMany(LedgerEntries::class, 'ledger_id')->orderBy('id');
    }
}
