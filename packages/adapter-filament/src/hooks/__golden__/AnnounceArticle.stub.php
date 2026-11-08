<?php

declare(strict_types=1);

namespace App\Hooks;

use App\Hooks\Contracts\AnnounceArticleHook;

// Ring 2 hook — hand-written. camis seeds this once and never overwrites it.
final class AnnounceArticle implements AnnounceArticleHook
{
    public function run(array $input): void
    {
        // TODO: implement the behavior for "AnnounceArticle" (runs afterCreate).
    }
}
