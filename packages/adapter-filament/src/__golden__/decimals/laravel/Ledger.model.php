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
        'share',
        'units',
        'fee',
        'limit_ceiling',
    ];

    protected function casts(): array
    {
        return [
            'balance' => \App\Casts\DecimalDigitsCast::class.':20,6',
            'rate' => \App\Casts\DecimalDigitsCast::class.':9,4',
            'share' => \App\Casts\DecimalDigitsCast::class.':15,5',
            'units' => \App\Casts\DecimalDigitsCast::class.':14,4',
            'fee' => 'decimal:2',
            'limit_ceiling' => \App\Casts\DecimalDigitsCast::class.':18,2',
        ];
    }

    public function entries(): HasMany
    {
        return $this->hasMany(LedgerEntries::class, 'ledger_id')->orderBy('id');
    }
}
