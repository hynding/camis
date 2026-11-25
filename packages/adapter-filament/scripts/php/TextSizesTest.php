<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Page;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Text columns sized by their bound (the text-sizes fixture, issue #123): a value past MySQL's TEXT
 * (65,535 bytes) is stored and read back whole, in the columns a bound of 524,288 characters, no
 * bound and a rich text get, at four bytes a character. CI's text-columns job copies this into the
 * scaffolded app's tests/Feature, once per database.
 */
class TextSizesTest extends TestCase
{
    use RefreshDatabase;

    /** More than 64 KiB, in characters of four bytes: the worst case a bound is sized for. */
    private function large(int $characters): string
    {
        return str_repeat("\u{1F600}", $characters);
    }

    public function test_values_past_64_kib_are_stored_and_read_back_whole(): void
    {
        $chapter = $this->large(20_000);
        $body = $this->large(70_000);
        $page = Page::query()->create(['title' => 'Long', 'chapter' => $chapter, 'body' => $body, 'markdown' => $body]);

        $found = Page::query()->findOrFail($page->getKey());
        $this->assertSame($chapter, $found->chapter);
        $this->assertSame($body, $found->body);
        $this->assertSame($body, $found->markdown);
    }

    public function test_a_bounded_text_keeps_a_value_at_its_bound(): void
    {
        $summary = str_repeat("\u{1F600}", 1000);
        $page = Page::query()->create(['title' => 'Short', 'summary' => $summary]);

        $this->assertSame($summary, Page::query()->findOrFail($page->getKey())->summary);
    }
}
