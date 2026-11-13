<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Book;
use App\Models\Note;
use App\Models\Secret;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Strapi's polymorphic relations (the morph-relations fixture), answered as strapi-php answers them:
 * a note's subjects (morphToMany) are written with each entry's __type and read back with it, a
 * note's pinned_to (morphToOne) is read only, and a book or a film reads the notes pinned to it
 * (morphMany, morphOne). A type the caller may not read is refused on write and left out on read.
 * CI's morph-relations job copies this into the scaffolded app's tests/Feature.
 */
class MorphRelationsTest extends TestCase
{
    use RefreshDatabase;

    private string $jwt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'planner']);
        $user->assignRole('authenticated');
        $this->jwt = $user->createToken('api')->plainTextToken;
    }

    private function api(string $method, string $uri, ?array $data = null): TestResponse
    {
        return $this->withHeader('Authorization', 'Bearer '.$this->jwt)->json($method, '/api/'.$uri, $data === null ? [] : ['data' => $data]);
    }

    private function make(string $type, string $title): string
    {
        return $this->api('POST', $type, ['title' => $title])->assertCreated()->json('data.documentId');
    }

    /** @return array{documentId: string, __type: string} */
    private function ref(string $documentId, string $type): array
    {
        return ['documentId' => $documentId, '__type' => "api::{$type}.{$type}"];
    }

    /** @return list<array{0: string, 1: string}> each linked entry's title and __type */
    private function subjects(string $note, string $query = ''): array
    {
        $subjects = $this->api('GET', "notes/{$note}?populate=subjects{$query}")->assertOk()->json('data.subjects');

        return array_map(fn (array $s) => [$s['title'], $s['__type']], $subjects);
    }

    private static function fixture(string $name): string
    {
        $directory = getenv('CAMIS_TRANSFER_FIXTURES') ?: base_path('../packages/adapter-filament/src/strapi-api/__fixtures__/transfer');

        return $directory.'/'.$name;
    }

    /** @return list<array<string, mixed>> one stage's records of an export archive */
    private static function archived(string $archive, string $stage): array
    {
        $records = [];
        foreach (new \RecursiveIteratorIterator(new \PharData($archive)) as $entry) {
            if (str_contains($entry->getPathname(), "/{$stage}/")) {
                foreach (array_filter(explode("\n", (string) file_get_contents($entry->getPathname()))) as $line) {
                    $records[] = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
                }
            }
        }

        return $records;
    }

    private function assertInvalidKey(TestResponse $response, string $key, string $source, ?string $param = null): void
    {
        $response->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')
            ->assertJsonPath('error.message', "Invalid key {$key}")
            ->assertJsonPath('error.details', ['key' => $key, 'path' => $key, 'source' => $source, ...($param === null ? [] : ['param' => $param])]);
    }

    public function test_a_note_links_entries_of_any_type_and_reads_each_with_its_type(): void
    {
        $dune = $this->make('books', 'Dune');
        $heat = $this->make('films', 'Heat');

        $created = $this->api('POST', 'notes', ['title' => 'n1', 'subjects' => [$this->ref($dune, 'book'), $this->ref($heat, 'film')]])
            ->assertCreated();
        $this->assertArrayNotHasKey('subjects', $created->json('data'));
        $note = $created->json('data.documentId');

        $this->api('GET', "notes/{$note}?populate=subjects&fields[0]=title")->assertOk()
            ->assertJsonPath('data.subjects.0.documentId', $dune)
            ->assertJsonPath('data.subjects.0.title', 'Dune')
            ->assertJsonPath('data.subjects.0.__type', 'api::book.book')
            ->assertJsonPath('data.subjects.1.documentId', $heat)
            ->assertJsonPath('data.subjects.1.__type', 'api::film.film');
        $this->assertSame(['id', 'documentId', 'title', 'createdAt', 'updatedAt', 'publishedAt', '__type'], array_keys($this->api('GET', "notes/{$note}?populate=subjects")->json('data.subjects.0')));
        $this->api('GET', "notes/{$note}?populate[subjects][count]=true&fields[0]=title")->assertOk()
            ->assertJsonPath('data.subjects', ['count' => 2]);
        $this->assertSame(['id', 'documentId', 'title', 'createdAt', 'updatedAt', 'publishedAt', 'subjects', 'pinned_to'], array_keys($this->api('GET', "notes/{$note}?populate=*")->json('data')));
    }

    public function test_a_write_replaces_connects_and_disconnects_links(): void
    {
        $dune = $this->make('books', 'Dune');
        $emma = $this->make('books', 'Emma');
        $heat = $this->make('films', 'Heat');
        $note = $this->api('POST', 'notes', ['title' => 'n1', 'subjects' => [$this->ref($dune, 'book'), $this->ref($heat, 'film'), $this->ref($dune, 'book')]])
            ->assertCreated()->json('data.documentId');
        $this->assertSame([['Dune', 'api::book.book'], ['Heat', 'api::film.film']], $this->subjects($note));

        $this->api('PUT', "notes/{$note}", ['subjects' => ['connect' => [$this->ref($emma, 'book')]]])->assertOk();
        $this->assertSame([['Dune', 'api::book.book'], ['Heat', 'api::film.film'], ['Emma', 'api::book.book']], $this->subjects($note));
        $this->api('PUT', "notes/{$note}", ['subjects' => ['disconnect' => [$this->ref($dune, 'book')]]])->assertOk();
        $this->assertSame([['Heat', 'api::film.film'], ['Emma', 'api::book.book']], $this->subjects($note));
        $this->api('PUT', "notes/{$note}", ['subjects' => ['set' => [$this->ref($dune, 'book')]]])->assertOk();
        $this->assertSame([['Dune', 'api::book.book']], $this->subjects($note));
        $this->api('PUT', "notes/{$note}", ['subjects' => []])->assertOk();
        $this->assertSame([], $this->subjects($note));
    }

    public function test_a_draft_keeps_its_own_links_until_it_is_published(): void
    {
        $dune = $this->make('books', 'Dune');
        $emma = $this->make('books', 'Emma');
        $note = $this->api('POST', 'notes', ['title' => 'n1', 'subjects' => [$this->ref($emma, 'book')]])->assertCreated()->json('data.documentId');

        $this->api('PUT', "notes/{$note}?status=draft", ['subjects' => [$this->ref($dune, 'book')]])->assertOk();
        $this->assertSame([['Emma', 'api::book.book']], $this->subjects($note));
        $this->assertSame([['Dune', 'api::book.book']], $this->subjects($note, '&status=draft'));
    }

    public function test_a_type_the_caller_may_not_read_is_refused_on_write_and_left_out_on_read(): void
    {
        $dune = $this->make('books', 'Dune');
        $vault = Secret::query()->create(['title' => 'Vault']);
        $this->assertInvalidKey($this->api('POST', 'notes', ['title' => 'n1', 'subjects' => [$this->ref($dune, 'book'), $this->ref($vault->document_id, 'secret')]]), 'subjects', 'body');
        $this->assertInvalidKey($this->api('POST', 'notes', ['title' => 'n1', 'subjects' => [$this->ref($dune, 'book'), $this->ref($dune, 'nope')]]), 'subjects', 'body');

        $note = $this->api('POST', 'notes', ['title' => 'n1', 'subjects' => [$this->ref($dune, 'book')]])->assertCreated()->json('data.documentId');
        foreach (Note::query()->where('document_id', $note)->get() as $row) {
            DB::table('notes_subjects_mph')->insert(['note_id' => $row->id, 'subjects_id' => $vault->id, 'subjects_type' => 'api::secret.secret', 'order' => 2]);
            $row->forceFill(['pinned_to_id' => $vault->id, 'pinned_to_type' => 'api::secret.secret'])->save();
        }

        $this->assertSame([['Dune', 'api::book.book']], $this->subjects($note));
        $this->api('GET', "notes/{$note}?populate[subjects][count]=true&populate[pinned_to][count]=true")->assertOk()
            ->assertJsonPath('data.subjects', ['count' => 1])
            ->assertJsonPath('data.pinned_to', ['count' => 0]);
        $this->api('GET', "notes/{$note}?populate=pinned_to")->assertOk()->assertJsonPath('data.pinned_to', null);
    }

    public function test_what_strapi_refuses(): void
    {
        $dune = $this->make('books', 'Dune');
        $this->assertInvalidKey($this->api('POST', 'notes', ['title' => 'x', 'subjects' => [['documentId' => $dune]]]), 'subjects', 'body');
        $this->assertInvalidKey($this->api('POST', 'notes', ['title' => 'x', 'subjects' => null]), 'subjects', 'body');
        $this->assertInvalidKey($this->api('POST', 'notes', ['title' => 'x', 'pinned_to' => $this->ref($dune, 'book')]), 'pinned_to', 'body');
        $this->api('POST', 'notes', ['title' => 'x', 'subjects' => [$this->ref('nope', 'book')]])->assertStatus(400)
            ->assertJsonPath('error.message', 'Document with id "nope", locale "" not found');

        $this->api('POST', 'notes', ['title' => 'n1', 'subjects' => [$this->ref($dune, 'book')]])->assertCreated();
        $this->assertInvalidKey($this->api('GET', 'notes?filters[subjects][title][$eq]=Dune'), 'subjects', 'query', 'filters');
        $this->assertInvalidKey($this->api('GET', 'notes?sort=subjects'), 'subjects', 'query', 'sort');
        $this->assertInvalidKey($this->api('GET', 'notes?fields[0]=pinned_to'), 'pinned_to', 'query', 'fields');
        $this->assertInvalidKey($this->api('GET', 'notes?populate=subjects.title'), 'subjects', 'query', 'populate');
    }

    public function test_a_book_or_a_film_reads_the_notes_that_link_it(): void
    {
        $dune = $this->make('books', 'Dune');
        $emma = $this->make('books', 'Emma');
        $heat = $this->make('films', 'Heat');
        $n1 = $this->api('POST', 'notes', ['title' => 'n1', 'subjects' => [$this->ref($dune, 'book')]])->assertCreated()->json('data.documentId');
        $n2 = $this->api('POST', 'notes', ['title' => 'n2'])->assertCreated()->json('data.documentId');
        $pin = fn (string $note, string $type, string $target) => Note::query()->where('document_id', $note)->update([
            'pinned_to_id' => ($type === 'book' ? Book::class : \App\Models\Film::class)::query()->where('document_id', $target)->value('id'),
            'pinned_to_type' => "api::{$type}.{$type}",
        ]);
        $pin($n1, 'film', $heat);
        $pin($n2, 'book', $dune);

        $this->api('GET', "notes/{$n2}?populate=pinned_to")->assertOk()
            ->assertJsonPath('data.pinned_to.documentId', $dune)
            ->assertJsonPath('data.pinned_to.__type', 'api::book.book');
        $this->api('GET', 'books?populate=pins&fields[0]=title&sort=title')->assertOk()
            ->assertJsonPath('data.0.pins.0.documentId', $n2)
            ->assertJsonPath('data.0.pins.0.title', 'n2')
            ->assertJsonPath('data.1.pins', []);
        $this->assertArrayNotHasKey('__type', $this->api('GET', 'books?populate=pins')->json('data.0.pins.0'));
        $this->assertNotNull($this->api('GET', 'books?populate=pins')->json('data.0.pins.0.publishedAt'));
        $this->api('GET', 'films?populate=pin&fields[0]=title')->assertOk()->assertJsonPath('data.0.pin.documentId', $n1);
        // Strapi reads a morphMany through a morphToMany by the link's own field, which a note's
        // write leaves empty.
        $this->api('GET', 'books?populate=remarks&fields[0]=title&sort=title')->assertOk()->assertJsonPath('data.0.remarks', []);
        $this->api('GET', 'books?filters[pins][title][$eq]=n2&fields[0]=title')->assertOk()
            ->assertJsonPath('data.0.documentId', $dune)
            ->assertJsonCount(1, 'data');
        $this->assertSame(['id', 'documentId', 'title', 'pins', 'remarks'], array_keys($this->api('GET', 'books?populate=*&fields[0]=title')->json('data.0')));
        $this->assertSame([$emma, $dune], array_column($this->api('GET', 'books?sort=pins.title&fields[0]=title')->json('data'), 'documentId'));
        // Its notes are read, never written through it.
        $this->api('POST', 'books', ['title' => 'Ulysses', 'pins' => []])->assertCreated();
    }

    public function test_a_strapi_archive_carries_the_links_in_and_out(): void
    {
        // strapi-php's export: n1's subjects are Heat then Dune and it is pinned to Heat, n2's
        // subject is Emma and it is pinned to Dune, on the draft and the published version alike.
        $this->artisan('strapi:import', ['--file' => self::fixture('morph-relations-export.tar.gz'), '--force' => true])->assertSuccessful();
        $n1 = (string) Note::query()->where('title', 'n1')->value('document_id');
        $n2 = (string) Note::query()->where('title', 'n2')->value('document_id');
        $this->assertSame([['Heat', 'api::film.film'], ['Dune', 'api::book.book']], $this->subjects($n1));
        $this->assertSame([['Heat', 'api::film.film'], ['Dune', 'api::book.book']], $this->subjects($n1, '&status=draft'));
        $this->assertSame([['Emma', 'api::book.book']], $this->subjects($n2));
        $this->api('GET', "notes/{$n2}?populate=pinned_to")->assertOk()
            ->assertJsonPath('data.pinned_to.title', 'Dune')
            ->assertJsonPath('data.pinned_to.__type', 'api::book.book');
        $this->api('GET', 'films?populate=pin')->assertOk()->assertJsonPath('data.0.pin.title', 'n1');

        $file = sys_get_temp_dir().'/camis-morph-'.uniqid();
        $this->artisan('strapi:export', ['--file' => $file, '--no-encrypt' => true])->assertSuccessful();
        $entities = [];
        foreach (array_filter(self::archived("{$file}.tar.gz", 'entities'), fn (array $e) => str_starts_with($e['type'], 'api::')) as $entity) {
            $entities[$entity['type']][$entity['id']] = $entity['data']['title'].($entity['data']['publishedAt'] ?? null ? '' : ' (draft)');
        }
        $links = array_values(array_filter(self::archived("{$file}.tar.gz", 'links'), fn (array $l) => $l['kind'] === 'relation.morph'));
        $said = array_map(fn (array $l) => sprintf(
            '%s %s.%s → %s %s%s',
            $l['relation'],
            $entities[$l['left']['type']][$l['left']['ref']],
            $l['left']['field'],
            $l['right']['type'],
            $entities[$l['right']['type']][$l['right']['ref']],
            isset($l['right']['pos']) ? " #{$l['right']['pos']}" : '',
        ), $links);
        sort($said);
        $this->assertSame([
            'morphToMany n1 (draft).subjects → api::book.book Dune #2',
            'morphToMany n1 (draft).subjects → api::film.film Heat #1',
            'morphToMany n1.subjects → api::book.book Dune #2',
            'morphToMany n1.subjects → api::film.film Heat #1',
            'morphToMany n2 (draft).subjects → api::book.book Emma #1',
            'morphToMany n2.subjects → api::book.book Emma #1',
            'morphToOne n1 (draft).pinned_to → api::film.film Heat',
            'morphToOne n1.pinned_to → api::film.film Heat',
            'morphToOne n2 (draft).pinned_to → api::book.book Dune',
            'morphToOne n2.pinned_to → api::book.book Dune',
        ], $said);
    }

    public function test_the_content_type_builder_names_them(): void
    {
        $ir = json_decode((string) file_get_contents(resource_path('camis/schema.json')), true, 512, JSON_THROW_ON_ERROR);
        $label = fn (string $type, string $field) => \App\Support\ContentTypeBuilderSchema::typeLabel(
            collect(collect($ir['contentTypes'])->firstWhere('name', $type)['fields'])->firstWhere('name', $field),
            $ir,
        );
        $this->assertSame('Relation with any type (many)', $label('Note', 'subjects'));
        $this->assertSame('Relation with any type (one)', $label('Note', 'pinnedTo'));
        $this->assertSame('Relation with Note, through pinnedTo (many)', $label('Book', 'pins'));
        $this->assertSame('Relation with Note, through pinnedTo (one)', $label('Film', 'pin'));
        // Strapi's builder cannot design them either: they are written in schema.json by hand.
        $this->assertFalse(\App\Support\ContentTypeBuilderSchema::designable(['type' => 'polymorphicRelation']));
        $this->assertTrue(\App\Support\ContentTypeBuilderSchema::designable(['type' => 'string']));
    }
}
