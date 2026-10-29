<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Books\Pages\CreateBook;
use App\Filament\Resources\Books\Pages\EditBook;
use App\Models\Author;
use App\Models\Book;
use App\Models\Genre;
use App\Models\User;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * Links made in the generated Filament admin (the strapi-api fixture's Book) take their place in
 * Strapi's link order as the Strapi admin's relation picker places them: a genre picked for a book,
 * and a book given an author, go to the end of the list they join. So a later API connect lands
 * after them, and the API lists them where they were made. CI copies this into the scaffolded
 * app's tests/Feature.
 */
class LinkOrderAdminTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private string $jwt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $this->admin = User::factory()->create(['username' => 'admin']);
        $this->admin->givePermissionTo(['book.read', 'book.create', 'book.update', 'author.read', 'genre.read']);
        $caller = User::factory()->create(['username' => 'caller']);
        $caller->assignRole('authenticated');
        $this->jwt = $caller->createToken('api')->plainTextToken;
    }

    private function inAdmin(): void
    {
        $this->actingAs($this->admin);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    /** @return array<string, mixed> the response's data */
    private function api(string $method, string $path, array $data = []): array
    {
        // The admin's session and the API caller's token are different callers.
        $this->app['auth']->forgetGuards();

        return $this->json($method, '/api'.$path, $data, ['Authorization' => 'Bearer '.$this->jwt])->assertSuccessful()->json('data');
    }

    public function test_genres_picked_in_the_admin_keep_their_place_when_the_api_connects_more(): void
    {
        [$alpha, $bravo, $charlie, $delta] = array_map(fn (string $name) => Genre::create(['name' => $name]), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
        $this->inAdmin();
        Livewire::test(CreateBook::class)
            ->fillForm(['title' => 'Dune', 'genres' => [$charlie->getKey(), $alpha->getKey()]])
            ->call('create')
            ->assertHasNoFormErrors();
        $book = Book::sole();
        Livewire::test(EditBook::class, ['record' => $book->getRouteKey()])
            ->fillForm(['genres' => [$charlie->getKey(), $alpha->getKey(), $bravo->getKey()]])
            ->call('save')
            ->assertHasNoFormErrors();

        $this->api('PUT', "/books/{$book->document_id}", ['data' => ['genres' => ['connect' => [$delta->document_id]]]]);

        $read = $this->api('GET', "/books/{$book->document_id}?populate=genres");
        $this->assertSame(['Charlie', 'Alpha', 'Bravo', 'Delta'], array_column($read['genres'], 'name'));
    }

    public function test_a_book_given_an_author_in_the_admin_goes_to_the_end_of_the_authors_books(): void
    {
        $ann = Author::create(['name' => 'Ann']);
        $this->api('POST', '/books', ['data' => ['title' => 'One', 'author' => $ann->document_id]]);
        $this->inAdmin();
        Livewire::test(CreateBook::class)
            ->fillForm(['title' => 'Two', 'author_id' => $ann->getKey()])
            ->call('create')
            ->assertHasNoFormErrors();
        $this->api('POST', '/books', ['data' => ['title' => 'Three', 'author' => $ann->document_id]]);

        $read = $this->api('GET', "/authors/{$ann->document_id}?populate=books");
        $this->assertSame(['One', 'Two', 'Three'], array_column($read['books'], 'title'));
    }
}
