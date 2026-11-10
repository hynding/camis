<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use App\Models\AdminUser;
use Filament\Facades\Filament;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

trait HasCreatorFields
{
    protected static function bootHasCreatorFields(): void
    {
        static::creating(function ($model): void {
            $user = self::adminUser();
            if ($user !== null) {
                $model->created_by_id ??= $user;
                $model->updated_by_id = $user;
            }
        });
        static::updating(function ($model): void {
            $user = self::adminUser();
            if ($user !== null) {
                $model->updated_by_id = $user;
            }
        });
    }

    /** The signed-in admin account's id, while the admin panel serves the write. */
    private static function adminUser(): ?int
    {
        if (Filament::getCurrentPanel() === null) {
            return null;
        }
        $id = Filament::auth()->id();

        return $id === null ? null : (int) $id;
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(AdminUser::class, 'created_by_id');
    }

    public function updatedBy(): BelongsTo
    {
        return $this->belongsTo(AdminUser::class, 'updated_by_id');
    }
}
