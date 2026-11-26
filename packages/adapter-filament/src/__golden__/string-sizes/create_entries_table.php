<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('entries', function (Blueprint $table): void {
            $table->id();
            $table->string('title')->nullable();
            $table->string('code', 40)->nullable();
            $table->text('headline')->nullable();
            $table->mediumText('abstract')->nullable();
            $table->text('contact')->nullable();
            $table->string('slug', 300)->nullable()->unique();
            $table->string('handle', 673)->nullable()->unique();
            $table->longText('unbounded')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('entries');
    }
};
