<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ledgers', function (Blueprint $table): void {
            $table->id();
            $table->string('label')->nullable();
            (Schema::getConnection()->getDriverName() === 'sqlite' ? $table->string('balance', 22) : $table->decimal('balance', 20, 6))->nullable();
            $table->decimal('rate', 9, 4)->nullable();
            (Schema::getConnection()->getDriverName() === 'sqlite' ? $table->string('share', 17) : $table->decimal('share', 15, 5))->nullable()->unique();
            $table->decimal('units', 14, 4)->nullable();
            $table->decimal('fee')->nullable();
            $table->string('lines')->nullable();
            (Schema::getConnection()->getDriverName() === 'sqlite' ? $table->string('limit_ceiling', 20) : $table->decimal('limit_ceiling', 18, 2))->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ledgers');
    }
};
