<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** A transfer token; as in Strapi, its key is kept only as a hash and shown once. */
final class StrapiTransferToken extends Model
{
    protected $table = 'strapi_transfer_tokens';

    protected $fillable = ['name', 'description', 'permissions'];

    protected $hidden = ['access_key'];

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
