<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** A webhook: where to POST which events, with what headers. */
final class StrapiWebhook extends Model
{
    protected $table = 'strapi_webhooks';

    public $timestamps = false;

    protected $fillable = ['name', 'url', 'headers', 'events', 'enabled'];

    protected $attributes = ['enabled' => true];

    protected function casts(): array
    {
        return [
            'headers' => 'array',
            'events' => 'array',
            'enabled' => 'boolean',
        ];
    }
}
