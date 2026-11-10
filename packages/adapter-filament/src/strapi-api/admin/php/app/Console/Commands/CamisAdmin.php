<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\AdminUser;
use Filament\Facades\Filament;
use Illuminate\Console\Command;
use Spatie\Permission\Models\Role;

/** Makes an admin account, or gives an existing one an admin role. */
final class CamisAdmin extends Command
{
    protected $signature = 'camis:admin
        {email : The admin\'s email address}
        {--name= : The admin\'s first name (defaults to the part of the email before the @)}
        {--lastname= : The admin\'s last name}
        {--username= : The admin\'s username}
        {--password= : The admin\'s password, at least 8 characters (asked for when left out)}
        {--role= : The admin role to give (defaults to the first one)}';

    protected $description = 'Create an admin account, or give an existing one an admin role';

    public function handle(): int
    {
        if (! AdminUser::EVERY_USER && AdminUser::ADMIN_ROLES === []) {
            $this->error('No role may sign in to the admin: mark one with "admin": true in the roles file, then rebuild');

            return self::FAILURE;
        }
        $role = AdminUser::EVERY_USER ? null : $this->option('role') ?? AdminUser::ADMIN_ROLES[0];
        if ($role !== null && ! in_array($role, AdminUser::ADMIN_ROLES, true)) {
            $this->error("\"{$role}\" is not an admin role; admin roles: " . implode(', ', AdminUser::ADMIN_ROLES));

            return self::FAILURE;
        }
        if ($role !== null && Role::query()->where('name', $role)->doesntExist()) {
            $this->error("The role \"{$role}\" has not been seeded; run php artisan db:seed first");

            return self::FAILURE;
        }

        $email = mb_strtolower((string) $this->argument('email'));
        $admin = AdminUser::query()->where('email', $email)->first();
        if ($admin === null) {
            $password = $this->option('password') ?? $this->secret('Password');
            if (! is_string($password) || strlen($password) < 8) {
                $this->error('The password must be at least 8 characters');

                return self::FAILURE;
            }
            $admin = new AdminUser();
            $admin->forceFill([
                'email' => $email,
                'firstname' => $this->option('name') ?? (strstr($email, '@', true) ?: $email),
                'lastname' => $this->option('lastname'),
                'username' => $this->option('username'),
                'is_active' => true,
                'password' => $password,
            ]);
            $admin->save();
        } elseif ($admin->blocked || ! $admin->is_active) {
            $this->warn("{$email} is blocked or inactive, and stays out of the admin until that changes");
        }

        if ($role !== null) {
            $admin->assignRole($role);
        }
        $this->info("{$email} holds " . ($role === null ? 'no role: every admin account may use the admin' : "the admin role {$role}"));
        $guard = Filament::getDefaultPanel()->getAuthGuard();
        if ($guard !== 'admin') {
            $this->warn("The admin panel signs in on the {$guard} guard, so this account cannot sign in yet: add ->authGuard('admin') after ->login() in app/Providers/Filament/AdminPanelProvider.php");
        }

        return self::SUCCESS;
    }
}
