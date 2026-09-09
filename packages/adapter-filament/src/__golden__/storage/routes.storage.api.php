<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

use App\Http\Controllers\Api\ActivitySessionApiController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\ConsumableApiController;
use App\Http\Controllers\Api\NoteApiController;
use App\Http\Controllers\Api\TaskApiController;
use App\Http\Controllers\Api\TransactionApiController;
use App\Http\Middleware\StrapiErrors;
use App\Http\Middleware\StrapiJwtGuard;
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
    Route::post('/auth/local', [AuthController::class, 'login'])->middleware($authThrottle);
    Route::post('/auth/local/register', [AuthController::class, 'register'])->middleware($authThrottle);

    Route::middleware(StrapiJwtGuard::class)->group(function (): void {
        Route::get('/users/me', [AuthController::class, 'me']);

        Route::get('/activity-sessions', [ActivitySessionApiController::class, 'index']);
        Route::post('/activity-sessions', [ActivitySessionApiController::class, 'store']);
        Route::get('/activity-sessions/{key}', [ActivitySessionApiController::class, 'show']);
        Route::put('/activity-sessions/{key}', [ActivitySessionApiController::class, 'update']);
        Route::delete('/activity-sessions/{key}', [ActivitySessionApiController::class, 'destroy']);

        Route::get('/consumables', [ConsumableApiController::class, 'index']);
        Route::post('/consumables', [ConsumableApiController::class, 'store']);
        Route::get('/consumables/{key}', [ConsumableApiController::class, 'show']);
        Route::put('/consumables/{key}', [ConsumableApiController::class, 'update']);
        Route::delete('/consumables/{key}', [ConsumableApiController::class, 'destroy']);

        Route::get('/notes', [NoteApiController::class, 'index']);
        Route::post('/notes', [NoteApiController::class, 'store']);
        Route::get('/notes/{key}', [NoteApiController::class, 'show']);
        Route::put('/notes/{key}', [NoteApiController::class, 'update']);
        Route::delete('/notes/{key}', [NoteApiController::class, 'destroy']);

        Route::get('/tasks', [TaskApiController::class, 'index']);
        Route::post('/tasks', [TaskApiController::class, 'store']);
        Route::get('/tasks/{key}', [TaskApiController::class, 'show']);
        Route::put('/tasks/{key}', [TaskApiController::class, 'update']);
        Route::delete('/tasks/{key}', [TaskApiController::class, 'destroy']);

        Route::get('/transactions', [TransactionApiController::class, 'index']);
        Route::post('/transactions', [TransactionApiController::class, 'store']);
        Route::get('/transactions/{key}', [TransactionApiController::class, 'show']);
        Route::put('/transactions/{key}', [TransactionApiController::class, 'update']);
        Route::delete('/transactions/{key}', [TransactionApiController::class, 'destroy']);
    });

    // Inside the group so hand-written routes inherit the Strapi error envelope.
    require __DIR__.'/api-custom.php';
});
