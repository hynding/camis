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
                $this->assertStringContainsString('kept pages.summary as longText', $output);
                $this->assertSame('longText', $recorded['pages']['summary']);
            } else {
                $this->assertSame('text', $recorded['pages']['summary']);
            }
        } finally {
            @unlink($types);
        }
    }
}
