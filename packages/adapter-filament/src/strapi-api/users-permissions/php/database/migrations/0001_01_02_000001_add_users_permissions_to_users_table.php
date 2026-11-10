<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('document_id', 24)->nullable()->unique();
            $table->string('provider')->default('local');
            $table->string('reset_password_token')->nullable()->index();
            $table->string('confirmation_token')->nullable()->index();
            $table->boolean('confirmed')->default(false);
            $table->boolean('blocked')->default(false);
        });
        // Accounts made before the plugin could sign in; they stay able to when confirmation is on.
        DB::table('users')->update(['confirmed' => true]);
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropUnique(['document_id']);
            $table->dropIndex(['reset_password_token']);
            $table->dropIndex(['confirmation_token']);
            $table->dropColumn(['document_id', 'provider', 'reset_password_token', 'confirmation_token', 'confirmed', 'blocked']);
        });
    }
};
