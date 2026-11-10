<?php

declare(strict_types=1);

// camis:schema-sync on the served database (the strapi-api job's matrix: sqlite, mysql, pgsql), where
// the feature tests' in-memory SQLite cannot reach: a dropped column comes back with its foreign key,
// an undeclared column and its index go, an abandoned table goes, a renumbered migration is
// recorded under its new name, and the rows stay. Run inside the app:
//   php artisan tinker --execute='require "../packages/adapter-filament/scripts/php/schema-sync-check.php";'

use App\Models\Author;
use App\Models\Post;
use App\Models\Tag;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

$fail = function (string $message): never {
    fwrite(STDERR, "schema sync: {$message}\n");
    exit(1);
};

$tag = Tag::create(['label' => 'kept']);
$author = Author::create(['name' => 'Ann']);
$post = Post::create(['title' => 'kept', 'views' => 3, 'author_id' => $author->id]);

Schema::table('posts', function ($table): void {
    $table->dropForeign(['author_id']);
});
Schema::table('posts', function ($table): void {
    $table->dropColumn(['author_id', 'views']);
});
Schema::table('tags', function ($table): void {
    $table->string('obsolete')->nullable()->index();
});
Schema::create('widgets', function ($table): void {
    $table->id();
});
DB::table('migrations')->insert(['migration' => '0001_01_02_000099_create_widgets_table', 'batch' => 1]);
DB::table('migrations')->where('migration', 'like', '%_create_tags_table')->update(['migration' => '0001_01_02_000077_create_tags_table']);

if (Artisan::call('camis:schema-sync', ['--force' => true]) !== 0) {
    $fail(Artisan::output());
}

foreach (['author_id', 'views'] as $column) {
    if (! Schema::hasColumn('posts', $column)) {
        $fail("posts.{$column} was not added back");
    }
}
if (DB::connection()->getDriverName() !== 'sqlite'
    && ! collect(Schema::getForeignKeys('posts'))->contains(fn (array $key): bool => $key['columns'] === ['author_id'])) {
    $fail('posts.author_id came back without its foreign key');
}
if (Schema::hasColumn('tags', 'obsolete')) {
    $fail('tags.obsolete was not dropped');
}
if (Schema::hasTable('widgets')) {
    $fail('the abandoned widgets table was not dropped');
}
if (Tag::query()->find($tag->id)?->label !== 'kept' || Post::query()->find($post->id)?->title !== 'kept') {
    $fail('rows were lost');
}
$files = array_map(fn (string $path): string => basename($path, '.php'), glob(database_path('migrations/0001_01_0[23]_*.php')) ?: []);
$recorded = DB::table('migrations')->where('migration', 'like', '0001_01_0%')->where('migration', 'not like', '0001_01_01_%')->pluck('migration')->all();
sort($files);
sort($recorded);
if ($files !== $recorded) {
    $fail('the migrations table does not list the generated migrations: '.json_encode(array_values(array_diff($files, $recorded))).' missing, '.json_encode(array_values(array_diff($recorded, $files))).' stale');
}
echo "SCHEMA SYNC OK\n";
