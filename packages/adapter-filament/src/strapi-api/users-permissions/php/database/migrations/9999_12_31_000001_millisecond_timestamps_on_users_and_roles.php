<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/*
 * Strapi keeps its users' and roles' timestamps to the millisecond. Laravel's users table and
 * Spatie's roles table keep seconds, so their columns are widened; this runs after Spatie's
 * migration, which is named for the day the app published it. SQLite keeps a datetime as the text
 * written, so there is nothing to widen there.
 */
return new class extends Migration
{
    public function up(): void
    {
        $this->precision(3);
    }

    public function down(): void
    {
        $this->precision(0);
    }

    private function precision(int $precision): void
    {
        if (Schema::getConnection()->getDriverName() === 'sqlite') {
            return;
        }
        foreach (['users', config('permission.table_names.roles', 'roles')] as $table) {
            if (! Schema::hasTable($table)) {
                continue;
            }
            Schema::table($table, function (Blueprint $table) use ($precision): void {
                $table->timestamp('created_at', $precision)->nullable()->change();
                $table->timestamp('updated_at', $precision)->nullable()->change();
            });
        }
    }
};
