<?php

declare(strict_types=1);

use App\Http\Controllers\Admin\StrapiAdminApiTokens;
use App\Http\Controllers\Admin\StrapiAdminController;
use App\Http\Middleware\StrapiErrors;
use Illuminate\Support\Facades\Route;

// Strapi's admin API, the part a client signs in through, beside Filament's own /admin pages
// (routes/transfer.php loads this file). A signed-in admin's access token is its only credential.
Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/admin/init', [StrapiAdminController::class, 'init']);
    Route::post('/admin/login', [StrapiAdminController::class, 'login']);
    Route::post('/admin/register-admin', [StrapiAdminController::class, 'registerAdmin']);
    Route::get('/admin/users/me', [StrapiAdminController::class, 'me']);

    Route::get('/admin/api-tokens', [StrapiAdminApiTokens::class, 'list']);
    Route::post('/admin/api-tokens', [StrapiAdminApiTokens::class, 'create']);
    Route::get('/admin/api-tokens/{id}', [StrapiAdminApiTokens::class, 'get'])->whereNumber('id');
    Route::put('/admin/api-tokens/{id}', [StrapiAdminApiTokens::class, 'update'])->whereNumber('id');
    Route::delete('/admin/api-tokens/{id}', [StrapiAdminApiTokens::class, 'revoke'])->whereNumber('id');
    Route::post('/admin/api-tokens/{id}/regenerate', [StrapiAdminApiTokens::class, 'regenerate'])->whereNumber('id');
});
