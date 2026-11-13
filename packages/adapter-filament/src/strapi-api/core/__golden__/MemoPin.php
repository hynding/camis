<?php

declare(strict_types=1);

namespace App\Hooks;

use App\Hooks\Contracts\MemoPinEndpoint;
use Illuminate\Http\Request;

// Ring 2 endpoint — hand-written. camis seeds this once and never overwrites it.
final class MemoPin implements MemoPinEndpoint
{
    public function handle(Request $request): mixed
    {
        // TODO: answer POST /api/memos/:id/pin.
        return ['data' => null];
    }
}
