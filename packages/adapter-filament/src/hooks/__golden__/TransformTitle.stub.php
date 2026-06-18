<?php

declare(strict_types=1);

namespace App\Hooks;

use App\Hooks\Contracts\TransformTitleHook;

// Ring 2 hook — hand-written. camis seeds this once and never overwrites it.
final class TransformTitle implements TransformTitleHook
{
    public function run(array $input): array
    {
        // TODO: implement the behavior for "TransformTitle".
        return $input;
    }
}
