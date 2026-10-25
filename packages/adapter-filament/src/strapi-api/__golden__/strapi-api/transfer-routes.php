<?php

// @camis:generated — do not edit. bootstrap/app.php loads this file (see camis scaffold).

declare(strict_types=1);

use App\Http\Controllers\Admin\StrapiTransferRunner;
use App\Http\Middleware\StrapiErrors;
use Illuminate\Support\Facades\Route;

// Strapi's transfer runner, beside Filament's own /admin routes; the token is its only credential.
Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/admin/transfer/runner/push', [StrapiTransferRunner::class, 'push']);
    Route::get('/admin/transfer/runner/pull', [StrapiTransferRunner::class, 'pull']);
});
