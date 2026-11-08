<?php

declare(strict_types=1);

namespace App\Hooks;

use App\Hooks\Contracts\IsOwnerPolicy;
use Illuminate\Http\Request;

// Ring 2 policy — hand-written. camis seeds this once and never overwrites it.
final class IsOwner implements IsOwnerPolicy
{
    public function allows(Request $request, string $action): bool
    {
        // TODO: decide whether the request may go on (Article: update, delete).
        return true;
    }
}
