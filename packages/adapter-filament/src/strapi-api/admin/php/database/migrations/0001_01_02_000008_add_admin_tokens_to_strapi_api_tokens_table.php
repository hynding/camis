<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Strapi 5's admin tokens share the API tokens' table: a kind tells them apart (a token made before
 * this is a content API token), an admin account owns each, and each keeps the permissions it was
 * given. An account's tokens go with it, as Strapi deletes them.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('strapi_api_tokens', function (Blueprint $table): void {
            $table->string('kind', 16)->default('content-api');
            $table->foreignId('admin_user_owner_id')->nullable()->constrained('admin_users')->cascadeOnDelete();
            $table->json('admin_permissions')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('strapi_api_tokens', function (Blueprint $table): void {
            $table->dropConstrainedForeignId('admin_user_owner_id');
            $table->dropColumn(['kind', 'admin_permissions']);
        });
    }
};
