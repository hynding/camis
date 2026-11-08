<?php

declare(strict_types=1);

namespace App\Hooks;

use App\Hooks\Contracts\SendDigestTask;

// Ring 2 scheduled task — hand-written. camis seeds this once and never overwrites it.
final class SendDigest implements SendDigestTask
{
    public function run(): void
    {
        // TODO: implement the task "SendDigest" (cron "0 7 * * 1-5").
    }
}
