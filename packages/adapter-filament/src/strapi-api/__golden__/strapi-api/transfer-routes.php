<?php

// @camis:generated — do not edit. bootstrap/app.php loads this file (see camis scaffold).

declare(strict_types=1);

use App\Http\Controllers\Admin\StrapiTransferDownload;
use App\Http\Controllers\Admin\StrapiTransferPull;
use App\Http\Controllers\Admin\StrapiTransferPush;
use App\Http\Controllers\Admin\StrapiTransferRunner;
use App\Http\Middleware\StrapiErrors;
use Illuminate\Support\Facades\Route;

// Strapi's transfer runner, beside Filament's own /admin routes; the token is its only credential.
Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/admin/transfer/runner/push', [StrapiTransferRunner::class, 'push']);
    Route::get('/admin/transfer/runner/pull', [StrapiTransferRunner::class, 'pull']);
    // The same transfers over plain HTTP (strapi-plugin-camis): an archive pushed in chunks, or pulled whole.
    Route::post('/admin/transfer/push', [StrapiTransferPush::class, 'start']);
    Route::put('/admin/transfer/push/{id}', [StrapiTransferPush::class, 'append'])->where('id', '[0-9a-f]{32}');
    Route::post('/admin/transfer/push/{id}/check', [StrapiTransferPush::class, 'check'])->where('id', '[0-9a-f]{32}');
    Route::post('/admin/transfer/push/{id}/apply', [StrapiTransferPush::class, 'apply'])->where('id', '[0-9a-f]{32}');
    Route::delete('/admin/transfer/push/{id}', [StrapiTransferPush::class, 'abort'])->where('id', '[0-9a-f]{32}');
    Route::get('/admin/transfer/pull', [StrapiTransferPull::class, 'export']);
});

// Strapi's admin API, which bootstrap/app.php reaches through this file.
require __DIR__.'/admin.php';

// An export the Data transfer page wrote; the link it signs is the only credential, for ten minutes.
Route::get('/admin/data-transfer/{file}', StrapiTransferDownload::class)
    ->middleware('signed')
    ->where('file', '[A-Za-z0-9][A-Za-z0-9_.-]*')
    ->name('camis.data-transfer.download');
