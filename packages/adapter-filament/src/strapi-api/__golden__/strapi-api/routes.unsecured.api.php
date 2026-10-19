<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

use App\Http\Controllers\Api\ArticleApiController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\AuthorApiController;
use App\Http\Controllers\Api\TagApiController;
use App\Http\Controllers\Api\UploadController;
use App\Http\Controllers\Api\UserController;
use App\Http\Middleware\StrapiActiveUser;
use App\Http\Middleware\StrapiCredentials;
use App\Http\Middleware\StrapiErrors;
use Illuminate\Support\Facades\Route;

// Laravel's middleware priority sort moves Authenticate and ThrottleRequests ahead of any
// unprioritised route middleware, so applying StrapiErrors to the group below would leave it
// running last — an unauthenticated or throttled request would never reach it, and would return
// Laravel's default error body. Prepending it to the 'api' group makes it the first pipe for
// every route in the group; the resolved list is deduplicated, so it still runs exactly once.
Route::prependMiddlewareToGroup('api', StrapiErrors::class);

// The only unauthenticated credential endpoints: throttled so they are not a guessing oracle.
// The rate is deployment-specific — see config/camis.php.
$authThrottle = 'throttle:'.(int) config('camis.auth_throttle_per_minute', 10).',1';

Route::middleware([StrapiErrors::class])->group(function () use ($authThrottle): void {
    Route::get('/_health', fn () => response()->noContent());
    Route::post('/auth/local', [AuthController::class, 'login'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);
    Route::post('/auth/local/register', [AuthController::class, 'register'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);
    Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);
    Route::post('/auth/reset-password', [AuthController::class, 'resetPassword'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);
    Route::get('/auth/email-confirmation', [AuthController::class, 'emailConfirmation'])->middleware(StrapiCredentials::class.':guest');
    Route::post('/auth/send-email-confirmation', [AuthController::class, 'sendEmailConfirmation'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);

    Route::middleware([])->group(function (): void {
        Route::get('/users/me', [UserController::class, 'me'])->middleware(['auth:sanctum', StrapiActiveUser::class]);
        Route::post('/auth/change-password', [AuthController::class, 'changePassword'])->middleware(['auth:sanctum', StrapiActiveUser::class]);

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

        Route::post('/upload', [UploadController::class, 'upload']);
        Route::get('/upload/files', [UploadController::class, 'find']);
        Route::get('/upload/files/{id}', [UploadController::class, 'findOne']);
        Route::delete('/upload/files/{id}', [UploadController::class, 'destroy']);
    });

    // Inside the group so hand-written routes inherit the Strapi error envelope.
    require __DIR__.'/api-custom.php';
});
