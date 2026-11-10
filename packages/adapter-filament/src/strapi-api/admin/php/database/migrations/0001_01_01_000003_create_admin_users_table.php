<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Strapi's admin_users: the admin's accounts, apart from the API's users. It runs before the
 * content types' tables, whose created_by_id and updated_by_id point here.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('admin_users', function (Blueprint $table): void {
            $table->id();
            $table->string('document_id')->nullable()->index();
            $table->string('firstname')->nullable();
            $table->string('lastname')->nullable();
            $table->string('username')->nullable();
            $table->string('email')->unique();
            $table->string('password')->nullable();
            $table->string('reset_password_token')->nullable();
            $table->string('registration_token')->nullable();
            $table->boolean('is_active')->default(false);
            $table->boolean('blocked')->default(false);
            $table->string('prefered_language')->nullable();
            $table->rememberToken();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('admin_users');
    }
};
