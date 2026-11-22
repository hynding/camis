<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ledgers_entries', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('ledger_id')->constrained('ledgers')->cascadeOnDelete();
            $table->string('memo')->nullable();
            (\Illuminate\Support\Facades\Schema::getConnection()->getDriverName() === 'sqlite' ? $table->string('amount', 22) : $table->decimal('amount', 20, 6))->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ledgers_entries');
    }
};
