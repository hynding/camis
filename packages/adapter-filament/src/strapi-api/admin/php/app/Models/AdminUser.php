<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\AdminAccess;
use Filament\Models\Contracts\FilamentUser;
use Filament\Models\Contracts\HasName;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Str;
use Spatie\Permission\Traits\HasRoles;

/**
 * An account of the admin (Strapi's admin::user), kept in admin_users apart from the API's users.
 * It signs in on the admin guard, holds the IR's admin roles through Spatie on the web guard the
 * roles are seeded on, and the generated AdminAccess decides whether it may sign in.
 *
 * @property int $id
 * @property string|null $firstname
 * @property string|null $lastname
 * @property string|null $username
 * @property string $email
 * @property bool $is_active
 * @property bool $blocked
 */
class AdminUser extends Authenticatable implements FilamentUser, HasName
{
    use AdminAccess, HasRoles, Notifiable;

    protected $table = 'admin_users';

    /** The IR's roles are seeded on the web guard; an admin account holds them there too. */
    protected string $guard_name = 'web';

    protected $fillable = [
        'firstname',
        'lastname',
        'username',
        'email',
        'password',
        'is_active',
        'blocked',
        'prefered_language',
    ];

    protected $hidden = [
        'password',
        'remember_token',
        'reset_password_token',
        'registration_token',
    ];

    /** A new account gets a documentId, as every Strapi 5 row has one. */
    protected static function booted(): void
    {
        static::creating(function (self $admin): void {
            if (($admin->document_id ?? '') === '') {
                $admin->document_id = Str::lower(Str::random(24));
            }
        });
    }

    protected function casts(): array
    {
        return [
            'password' => 'hashed',
            'is_active' => 'boolean',
            'blocked' => 'boolean',
        ];
    }

    /** How the admin names the account: its full name, else its username, else its email. */
    public function getFilamentName(): string
    {
        $name = trim(($this->firstname ?? '') . ' ' . ($this->lastname ?? ''));

        return $name !== '' ? $name : ($this->username ?? $this->email);
    }

    /** @return Attribute<string, never> */
    protected function name(): Attribute
    {
        return Attribute::get(fn (): string => $this->getFilamentName());
    }
}
