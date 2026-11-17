<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * A content API token; its key is kept only as a hash and, for the admin to show again, encrypted.
 * The table holds admin tokens too (StrapiAdminToken), which this model never reads.
 *
 * @property \Illuminate\Support\Carbon|null $last_used_at
 * @property \Illuminate\Support\Carbon|null $expires_at
 */
final class StrapiApiToken extends Model
{
    protected $table = 'strapi_api_tokens';

    protected $fillable = ['name', 'description', 'type', 'permissions'];

    protected $hidden = ['access_key', 'encrypted_key'];

    protected static function booted(): void
    {
        static::addGlobalScope('content-api', fn (Builder $query) => $query->where('kind', 'content-api'));
    }

    protected function casts(): array
    {
        return [
            'permissions' => 'array',
            'last_used_at' => 'datetime',
            'expires_at' => 'datetime',
            'lifespan' => 'integer',
        ];
    }
}
