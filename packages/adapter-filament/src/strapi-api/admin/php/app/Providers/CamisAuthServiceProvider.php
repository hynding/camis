<?php

declare(strict_types=1);

namespace App\Providers;

use App\Auth\CamisAdminUserProvider;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\ServiceProvider;

/**
 * Puts the admin guard's accounts behind CamisAdminUserProvider. config/auth.php keeps Laravel's
 * eloquent driver, so an app that does not register this provider (one scaffolded before it, until
 * bootstrap/providers.php lists it) still signs its admins in as before.
 */
final class CamisAuthServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        config(['auth.providers.admin_users.driver' => 'camis-admin']);
    }

    public function boot(): void
    {
        Auth::provider('camis-admin', fn ($app, array $config): CamisAdminUserProvider => new CamisAdminUserProvider($app['hash'], $config['model']));
    }
}
