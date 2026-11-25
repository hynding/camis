<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Page;
use App\Support\CamisSchemaSync;
use App\Support\ColumnConversion;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

/**
 * What the schema sync does with a text column whose declared size differs from the recorded one (the
 * text-sizes fixture, issue #123): MySQL widens it and never narrows it, the other databases hold
 * one text type and leave it. CI's text-columns job runs this on each database, MySQL included,
 * which the Content-Type Builder's own test (sqlite only there) does not.
 */
class TextSchemaSyncTest extends TestCase
{
    use RefreshDatabase;

    /** More than 64 KiB, in characters of four bytes. */
    private const LARGE = 70_000;

    private function mysql(): bool
    {
        return in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true);
    }

    /** Sets the types the last sync recorded, as if the columns had been made as these. */
    private function recordColumnTypes(array $types): string
    {
        $path = CamisSchemaSync::columnTypesPath(DB::connection());
        @mkdir(dirname($path), 0777, true);
        file_put_contents($path, json_encode($types));

        return $path;
    }

    /** The model's bound on "summary" removed, as the generated migration would say it. */
    private function declareSummaryUnbounded(): void
    {
        $file = glob(database_path('migrations/*_create_pages_table.php'))[0];
        $this->migration = [$file, (string) file_get_contents($file)];
        file_put_contents($file, str_replace("\$table->text('summary')", "\$table->longText('summary')", $this->migration[1]));
    }

    protected function tearDown(): void
    {
        if ($this->migration !== null) {
            file_put_contents($this->migration[0], $this->migration[1]);
        }
        parent::tearDown();
    }

    /** @var array{0: string, 1: string}|null */
    private ?array $migration = null;

    private function columnType(string $column): string
    {
        return strtolower(Schema::getColumnType('pages', $column));
    }

    public function test_the_text_sizes_are_one_type_where_a_database_has_one_and_never_narrow_on_mysql(): void
    {
        $change = ColumnConversion::sizeChange(...);
        $this->assertSame('widen', $change('mysql', 'text', 'longText'));
        $this->assertSame('widen', $change('mariadb', 'mediumText', 'longText'));
        $this->assertSame('narrow', $change('mysql', 'longText', 'text'));
        $this->assertSame('same', $change('mysql', 'text', 'text'));
        $this->assertSame('same', $change('sqlite', 'text', 'longText'));
        $this->assertSame('same', $change('pgsql', 'longText', 'text'));
        // Not a change between text sizes: a string is sized by its length, a number is another group.
        $this->assertNull($change('mysql', 'string(255)', 'text'));
        $this->assertNull($change('mysql', 'text', 'integer'));
    }

    public function test_a_live_text_column_is_read_by_the_name_the_database_gives_its_type(): void
    {
        // information_schema's DATA_TYPE, as Schema::getColumnType answers it on MySQL and MariaDB.
        $named = ColumnConversion::textSizeOf(...);
        $this->assertSame('tinyText', $named('tinytext'));
        $this->assertSame('text', $named('text'));
        $this->assertSame('mediumText', $named('mediumtext'));
        $this->assertSame('longText', $named('LONGTEXT'));
        $this->assertNull($named('varchar'));
        $this->assertNull($named('json'));
    }

    public function test_the_live_size_decides_only_where_the_record_is_missing_or_a_text_type(): void
    {
        $uses = ColumnConversion::readsLiveSize(...);
        // MariaDB keeps JSON as a LONGTEXT: a recorded JSON column is another group, converted, not a text size.
        $this->assertFalse($uses('mariadb', 'json', 'longText'));
        $this->assertFalse($uses('mysql', 'json', 'text'));
        $this->assertFalse($uses('mysql', 'integer', 'text'));
        // A record of a text type, a string, or none, leaves the live column to say.
        $this->assertTrue($uses('mysql', 'text', 'longText'));
        $this->assertTrue($uses('mariadb', 'longText', 'text'));
        $this->assertTrue($uses('mysql', 'string(255)', 'text'));
        $this->assertTrue($uses('mysql', null, 'longText'));
        // One text type elsewhere, and a declared type that is no text size.
        $this->assertFalse($uses('sqlite', 'text', 'longText'));
        $this->assertFalse($uses('pgsql', null, 'longText'));
        $this->assertFalse($uses('mysql', 'text', 'string(255)'));
    }

    public function test_the_type_a_column_has_is_the_live_one_whenever_it_was_read(): void
    {
        $this->assertSame('text', ColumnConversion::currentType('text', 'longText'));
        $this->assertSame('text', ColumnConversion::currentType('text', null));
        $this->assertSame('longText', ColumnConversion::currentType(null, 'longText'));
        $this->assertNull(ColumnConversion::currentType(null, null));
    }

    public function test_an_old_text_column_is_widened_on_mysql_and_left_alone_elsewhere(): void
    {
        // As if "body", now an unbounded text, had been made as TEXT by the migration of before.
        Schema::table('pages', fn ($table) => $table->text('body')->nullable()->change());
        if ($this->mysql()) {
            $this->assertSame('text', $this->columnType('body'));
        }
        $types = $this->recordColumnTypes(['pages' => ['body' => 'text']]);

        try {
            $this->assertSame(0, Artisan::call('camis:schema-sync', ['--force' => true]));

            $this->assertSame($this->mysql(), str_contains(Artisan::output(), 'changed pages.body'));
            if ($this->mysql()) {
                $this->assertSame('longtext', $this->columnType('body'));
            }
            $recorded = json_decode((string) file_get_contents($types), true);
            $this->assertSame('longText', $recorded['pages']['body']);

            $body = str_repeat("\u{1F600}", self::LARGE);
            Page::query()->create(['title' => 'Long', 'body' => $body]);
            $this->assertSame($body, Page::query()->where('title', 'Long')->value('body'));
        } finally {
            @unlink($types);
        }
    }

    public function test_a_text_column_is_never_narrowed_on_its_own(): void
    {
        // As if "summary", which now holds 1,000 characters, had been a longText.
        Schema::table('pages', fn ($table) => $table->longText('summary')->nullable()->change());
        $before = $this->columnType('summary');
        $types = $this->recordColumnTypes(['pages' => ['summary' => 'longText']]);
        $value = str_repeat("\u{1F600}", self::LARGE);
        Page::query()->create(['title' => 'Kept', 'summary' => $value]);

        try {
            $this->assertSame(0, Artisan::call('camis:schema-sync', ['--force' => true]));

            $output = Artisan::output();
            $this->assertStringNotContainsString('changed pages.summary', $output);
            $this->assertSame($before, $this->columnType('summary'));
            $this->assertSame($value, Page::query()->where('title', 'Kept')->value('summary'));
            $recorded = json_decode((string) file_get_contents($types), true);
            if ($this->mysql()) {
                $this->assertSame('longtext', $this->columnType('summary'));
                // The guard's own words: a refusal by the database (the 280 KB row would not fit) says "cannot change it".
                $this->assertStringContainsString('kept pages.summary as longText: narrowing it to text could cut its values', $output);
                $this->assertStringNotContainsString('cannot change it', $output);
                $this->assertSame('longText', $recorded['pages']['summary']);
            } else {
                $this->assertSame('text', $recorded['pages']['summary']);
            }
        } finally {
            @unlink($types);
        }
    }

    public function test_a_narrowing_that_would_succeed_is_still_not_made(): void
    {
        // No row holds more than a few characters, so MySQL would narrow the column without complaint.
        Schema::table('pages', fn ($table) => $table->longText('summary')->nullable()->change());
        Page::query()->create(['title' => 'Short', 'summary' => 'brief']);
        $types = $this->recordColumnTypes(['pages' => ['summary' => 'longText']]);

        try {
            $this->assertSame(0, Artisan::call('camis:schema-sync', ['--force' => true]));

            $this->assertStringNotContainsString('changed pages.summary', Artisan::output());
            if ($this->mysql()) {
                $this->assertSame('longtext', $this->columnType('summary'));
            }
            $this->assertSame('brief', Page::query()->where('title', 'Short')->value('summary'));
        } finally {
            @unlink($types);
        }
    }

    /** What the sync reads of a column's text size is the live column, so a column the owner narrowed is widened again. */
    public function test_the_sync_widens_a_column_the_owner_narrowed_by_hand_when_the_model_asks_for_more(): void
    {
        if (! $this->mysql()) {
            $this->markTestSkipped('Only MySQL has several text sizes.');
        }
        // The model declares text for "summary" and the column is a longText: the sync keeps it.
        Schema::table('pages', fn ($table) => $table->longText('summary')->nullable()->change());
        $types = $this->recordColumnTypes(['pages' => ['summary' => 'longText']]);

        try {
            Artisan::call('camis:schema-sync', ['--force' => true]);
            $this->assertStringContainsString('kept pages.summary as longText', Artisan::output());
            $this->assertSame('longtext', $this->columnType('summary'));

            // The owner narrows it by hand: what the sync keeps is no longer true of the column.
            DB::statement('ALTER TABLE pages MODIFY summary TEXT NULL');
            Artisan::call('camis:schema-sync', ['--force' => true]);
            $this->assertStringNotContainsString('kept pages.summary', Artisan::output());
            $recorded = json_decode((string) file_get_contents($types), true);
            $this->assertSame('text', $recorded['pages']['summary']);

            // The model now asks for a longText (its bound removed): the live TEXT column is widened.
            $this->declareSummaryUnbounded();
            Artisan::call('camis:schema-sync', ['--force' => true]);
            $this->assertStringContainsString('changed pages.summary', Artisan::output());
            $this->assertSame('longtext', $this->columnType('summary'));

            $value = str_repeat("\u{1F600}", self::LARGE);
            Page::query()->create(['title' => 'Large', 'summary' => $value]);
            $this->assertSame($value, Page::query()->where('title', 'Large')->value('summary'));
        } finally {
            @unlink($types);
        }
    }

    public function test_the_sync_widens_a_live_text_column_whatever_the_recorded_type_says(): void
    {
        if (! $this->mysql()) {
            $this->markTestSkipped('Only MySQL has several text sizes.');
        }
        // Recorded as a longText, as a sync that kept it left it, but narrowed by hand since.
        DB::statement('ALTER TABLE pages MODIFY summary TEXT NULL');
        $types = $this->recordColumnTypes(['pages' => ['summary' => 'longText']]);
        $this->declareSummaryUnbounded();

        try {
            Artisan::call('camis:schema-sync', ['--force' => true]);

            $this->assertStringContainsString('changed pages.summary', Artisan::output());
            $this->assertSame('longtext', $this->columnType('summary'));
            $value = str_repeat("\u{1F600}", self::LARGE);
            Page::query()->create(['title' => 'Large', 'summary' => $value]);
            $this->assertSame($value, Page::query()->where('title', 'Large')->value('summary'));
        } finally {
            @unlink($types);
        }
    }
}
