<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('pages', function (Blueprint $table): void {
            $table->id();
            $table->string('title')->nullable();
            $table->text('summary')->nullable();
            $table->mediumText('chapter')->nullable();
            $table->longText('body')->nullable();
            $table->longText('markdown')->nullable();
            $table->longText('unbounded')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('pages');
    }
};
