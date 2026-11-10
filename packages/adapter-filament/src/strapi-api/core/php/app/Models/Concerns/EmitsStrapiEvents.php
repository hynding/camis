<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use App\Support\StrapiWebhooks;
use Illuminate\Database\Eloquent\Model;

trait EmitsStrapiEvents
{
    protected static function bootEmitsStrapiEvents(): void
    {
        static::saved(fn (Model $row) => StrapiWebhooks::saved($row));
        static::deleted(fn (Model $row) => StrapiWebhooks::deleted($row));
    }
}
