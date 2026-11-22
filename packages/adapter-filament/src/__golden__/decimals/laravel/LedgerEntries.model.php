<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class LedgerEntries extends Model
{
    protected $table = 'ledgers_entries';

    protected $fillable = [
        'memo',
        'amount',
    ];

    protected function casts(): array
    {
        return [
            'amount' => \App\Casts\DecimalDigitsCast::class.':20,6',
        ];
    }
}
