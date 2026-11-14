<?php

declare(strict_types=1);

namespace App\Models\Concerns;

/**
 * Strapi keeps milliseconds in every datetime it stores, so two writes within one second still
 * sort apart (`sort=updatedAt:desc`) and a timestamp read back equals the one sent.
 */
trait HasMillisecondTimestamps
{
    public function getDateFormat(): string
    {
        return 'Y-m-d H:i:s.v';
    }
}
