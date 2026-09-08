<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

use App\Http\Controllers\Api\ArticleApiController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\AuthorApiController;
use App\Http\Controllers\Api\TagApiController;
use App\Http\Middleware\StrapiErrors;
use Illuminate\Support\Facades\Route;

Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/_health', fn () => response()->noContent());
    // The only unauthenticated credential endpoints: throttled so they are not a guessing oracle.
    Route::post('/auth/local', [AuthController::class, 'login'])->middleware('throttle:10,1');
    Route::post('/auth/local/register', [AuthController::class, 'register'])->middleware('throttle:10,1');

    Route::middleware([])->group(function (): void {
        Route::get('/users/me', [AuthController::class, 'me']);

        Route::get('/articles', [ArticleApiController::class, 'index']);
        Route::post('/articles', [ArticleApiController::class, 'store']);
        Route::get('/articles/{key}', [ArticleApiController::class, 'show']);
        Route::put('/articles/{key}', [ArticleApiController::class, 'update']);
        Route::delete('/articles/{key}', [ArticleApiController::class, 'destroy']);

        Route::get('/authors', [AuthorApiController::class, 'index']);
        Route::post('/authors', [AuthorApiController::class, 'store']);
        Route::get('/authors/{key}', [AuthorApiController::class, 'show']);
        Route::put('/authors/{key}', [AuthorApiController::class, 'update']);
        Route::delete('/authors/{key}', [AuthorApiController::class, 'destroy']);

        Route::get('/tags', [TagApiController::class, 'index']);
        Route::post('/tags', [TagApiController::class, 'store']);
        Route::get('/tags/{key}', [TagApiController::class, 'show']);
        Route::put('/tags/{key}', [TagApiController::class, 'update']);
        Route::delete('/tags/{key}', [TagApiController::class, 'destroy']);
    });

    // Inside the group so hand-written routes inherit the Strapi error envelope.
    require __DIR__.'/api-custom.php';
});
