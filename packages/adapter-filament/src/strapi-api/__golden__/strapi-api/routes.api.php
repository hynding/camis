<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

use App\Http\Controllers\Api\ActivityApiController;
use App\Http\Controllers\Api\ActivitySessionApiController;
use App\Http\Controllers\Api\ArticleApiController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\AuthorApiController;
use App\Http\Controllers\Api\BookApiController;
use App\Http\Controllers\Api\CategoryApiController;
use App\Http\Controllers\Api\GenreApiController;
use App\Http\Controllers\Api\NoteApiController;
use App\Http\Controllers\Api\PageApiController;
use App\Http\Controllers\Api\PostApiController;
use App\Http\Controllers\Api\TagApiController;
use App\Http\Controllers\Api\TopicApiController;
use App\Http\Controllers\Api\TransactionApiController;
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
    Route::post('/auth/local', [AuthController::class, 'login'])->middleware($authThrottle);
    Route::post('/auth/local/register', [AuthController::class, 'register'])->middleware($authThrottle);

    Route::middleware('auth:sanctum')->group(function (): void {
        Route::get('/users/me', [AuthController::class, 'me']);

        Route::get('/activities', [ActivityApiController::class, 'index']);
        Route::post('/activities', [ActivityApiController::class, 'store']);
        Route::get('/activities/{key}', [ActivityApiController::class, 'show']);
        Route::put('/activities/{key}', [ActivityApiController::class, 'update']);
        Route::delete('/activities/{key}', [ActivityApiController::class, 'destroy']);

        Route::get('/activity-sessions', [ActivitySessionApiController::class, 'index']);
        Route::post('/activity-sessions', [ActivitySessionApiController::class, 'store']);
        Route::get('/activity-sessions/{key}', [ActivitySessionApiController::class, 'show']);
        Route::put('/activity-sessions/{key}', [ActivitySessionApiController::class, 'update']);
        Route::delete('/activity-sessions/{key}', [ActivitySessionApiController::class, 'destroy']);

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

        Route::get('/books', [BookApiController::class, 'index']);
        Route::post('/books', [BookApiController::class, 'store']);
        Route::get('/books/{key}', [BookApiController::class, 'show']);
        Route::put('/books/{key}', [BookApiController::class, 'update']);
        Route::delete('/books/{key}', [BookApiController::class, 'destroy']);

        Route::get('/categories', [CategoryApiController::class, 'index']);
        Route::post('/categories', [CategoryApiController::class, 'store']);
        Route::get('/categories/{key}', [CategoryApiController::class, 'show']);
        Route::put('/categories/{key}', [CategoryApiController::class, 'update']);
        Route::delete('/categories/{key}', [CategoryApiController::class, 'destroy']);

        Route::get('/genres', [GenreApiController::class, 'index']);
        Route::post('/genres', [GenreApiController::class, 'store']);
        Route::get('/genres/{key}', [GenreApiController::class, 'show']);
        Route::put('/genres/{key}', [GenreApiController::class, 'update']);
        Route::delete('/genres/{key}', [GenreApiController::class, 'destroy']);

        Route::get('/notes', [NoteApiController::class, 'index']);
        Route::post('/notes', [NoteApiController::class, 'store']);
        Route::get('/notes/{key}', [NoteApiController::class, 'show']);
        Route::put('/notes/{key}', [NoteApiController::class, 'update']);
        Route::delete('/notes/{key}', [NoteApiController::class, 'destroy']);

        Route::get('/pages', [PageApiController::class, 'index']);
        Route::post('/pages', [PageApiController::class, 'store']);
        Route::get('/pages/{key}', [PageApiController::class, 'show']);
        Route::put('/pages/{key}', [PageApiController::class, 'update']);
        Route::delete('/pages/{key}', [PageApiController::class, 'destroy']);

        Route::get('/posts', [PostApiController::class, 'index']);
        Route::post('/posts', [PostApiController::class, 'store']);
        Route::get('/posts/{key}', [PostApiController::class, 'show']);
        Route::put('/posts/{key}', [PostApiController::class, 'update']);
        Route::delete('/posts/{key}', [PostApiController::class, 'destroy']);

        Route::get('/tags', [TagApiController::class, 'index']);
        Route::post('/tags', [TagApiController::class, 'store']);
        Route::get('/tags/{key}', [TagApiController::class, 'show']);
        Route::put('/tags/{key}', [TagApiController::class, 'update']);
        Route::delete('/tags/{key}', [TagApiController::class, 'destroy']);

        Route::get('/topics', [TopicApiController::class, 'index']);
        Route::post('/topics', [TopicApiController::class, 'store']);
        Route::get('/topics/{key}', [TopicApiController::class, 'show']);
        Route::put('/topics/{key}', [TopicApiController::class, 'update']);
        Route::delete('/topics/{key}', [TopicApiController::class, 'destroy']);

        Route::get('/transactions', [TransactionApiController::class, 'index']);
        Route::post('/transactions', [TransactionApiController::class, 'store']);
        Route::get('/transactions/{key}', [TransactionApiController::class, 'show']);
        Route::put('/transactions/{key}', [TransactionApiController::class, 'update']);
        Route::delete('/transactions/{key}', [TransactionApiController::class, 'destroy']);
    });

    // Inside the group so hand-written routes inherit the Strapi error envelope.
    require __DIR__.'/api-custom.php';
});
