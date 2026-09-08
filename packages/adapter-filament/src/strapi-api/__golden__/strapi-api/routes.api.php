<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

use App\Http\Controllers\Api\ActivityApiController;
use App\Http\Controllers\Api\ActivitySessionApiController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\NoteApiController;
use App\Http\Controllers\Api\TagApiController;
use App\Http\Controllers\Api\TransactionApiController;
use App\Http\Middleware\StrapiErrors;
use Illuminate\Support\Facades\Route;

Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/_health', fn () => response()->noContent());
    Route::post('/auth/local', [AuthController::class, 'login']);
    Route::post('/auth/local/register', [AuthController::class, 'register']);

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

        Route::get('/notes', [NoteApiController::class, 'index']);
        Route::post('/notes', [NoteApiController::class, 'store']);
        Route::get('/notes/{key}', [NoteApiController::class, 'show']);
        Route::put('/notes/{key}', [NoteApiController::class, 'update']);
        Route::delete('/notes/{key}', [NoteApiController::class, 'destroy']);

        Route::get('/tags', [TagApiController::class, 'index']);
        Route::post('/tags', [TagApiController::class, 'store']);
        Route::get('/tags/{key}', [TagApiController::class, 'show']);
        Route::put('/tags/{key}', [TagApiController::class, 'update']);
        Route::delete('/tags/{key}', [TagApiController::class, 'destroy']);

        Route::get('/transactions', [TransactionApiController::class, 'index']);
        Route::post('/transactions', [TransactionApiController::class, 'store']);
        Route::get('/transactions/{key}', [TransactionApiController::class, 'show']);
        Route::put('/transactions/{key}', [TransactionApiController::class, 'update']);
        Route::delete('/transactions/{key}', [TransactionApiController::class, 'destroy']);
    });
});

require __DIR__.'/api-custom.php';
