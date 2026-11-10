<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('strapi_transfer_tokens', function (Blueprint $table): void {
            $table->id();
            $table->string('name')->unique();
            $table->string('description')->default('');
            $table->string('access_key', 128)->unique();
            $table->json('permissions');
            $table->dateTime('last_used_at')->nullable();
            $table->dateTime('expires_at')->nullable();
            $table->unsignedBigInteger('lifespan')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('strapi_transfer_tokens');
    }
};
