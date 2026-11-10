<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/*
 * Named for no real day because Spatie's migration, which makes the roles table, is named for the
 * day the app published it: this one has to run after it, whenever that was.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table(config('permission.table_names.roles', 'roles'), function (Blueprint $table): void {
            $table->string('document_id', 24)->nullable()->unique();
        });
    }

    public function down(): void
    {
        Schema::table(config('permission.table_names.roles', 'roles'), function (Blueprint $table): void {
            $table->dropUnique(['document_id']);
            $table->dropColumn('document_id');
        });
    }
};
