<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('strapi_webhooks', function (Blueprint $table): void {
            $table->id();
            $table->string('name')->nullable();
            $table->text('url')->nullable();
            $table->json('headers')->nullable();
            $table->json('events')->nullable();
            $table->boolean('enabled')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('strapi_webhooks');
    }
};
