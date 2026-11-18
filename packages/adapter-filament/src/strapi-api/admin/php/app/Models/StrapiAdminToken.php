<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * An admin token (Strapi 5's `kind: 'admin'`): it acts in the admin as the account that owns it,
 * with the permissions it was given. Its key is kept as a hash and, for its owner, encrypted.
 *
 * @property int $id
 * @property string $name
 * @property string $description
 * @property int|null $admin_user_owner_id
 * @property list<string>|null $admin_permissions
 * @property int|null $lifespan
 * @property string|null $encrypted_key
 * @property \Illuminate\Support\Carbon|null $last_used_at
 * @property \Illuminate\Support\Carbon|null $expires_at
 * @property \Illuminate\Support\Carbon|null $created_at
 * @property \Illuminate\Support\Carbon|null $updated_at
 */
final class StrapiAdminToken extends Model
{
    protected $table = 'strapi_api_tokens';

    protected $fillable = ['name', 'description', 'admin_permissions'];

    protected $hidden = ['access_key', 'encrypted_key'];

    protected $attributes = ['kind' => 'admin', 'type' => 'read-only'];

    protected static function booted(): void
    {
        static::addGlobalScope('admin', fn (Builder $query) => $query->where('kind', 'admin'));
    }

    /** @return BelongsTo<AdminUser, $this> */
    public function owner(): BelongsTo
    {
        return $this->belongsTo(AdminUser::class, 'admin_user_owner_id');
    }

    protected function casts(): array
    {
        return [
            'admin_permissions' => 'array',
            'last_used_at' => 'datetime',
            'expires_at' => 'datetime',
            'lifespan' => 'integer',
        ];
    }
}
