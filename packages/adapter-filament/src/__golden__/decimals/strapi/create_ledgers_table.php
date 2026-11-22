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
            $table->string('document_id', 24)->unique();
            $table->string('label')->nullable();
            (\Illuminate\Support\Facades\Schema::getConnection()->getDriverName() === 'sqlite' ? $table->string('balance', 22) : $table->decimal('balance', 20, 6))->nullable();
            $table->decimal('rate', 9, 4)->nullable();
            $table->decimal('fee')->nullable();
            (\Illuminate\Support\Facades\Schema::getConnection()->getDriverName() === 'sqlite' ? $table->string('limit_ceiling', 20) : $table->decimal('limit_ceiling', 18, 2))->nullable();
            $table->foreignId('created_by_id')->nullable()->constrained('admin_users')->nullOnDelete();
            $table->foreignId('updated_by_id')->nullable()->constrained('admin_users')->nullOnDelete();
            $table->timestamps(3);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ledgers');
    }
};
