<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Authors\Pages\EditAuthor;
use App\Filament\Resources\Books\Pages\CreateBook;
use App\Filament\Resources\Books\Pages\EditBook;
use App\Models\AdminUser;
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

    private AdminUser $admin;

    private string $jwt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $this->admin = AdminUser::forceCreate(['firstname' => 'Admin', 'email' => 'admin@example.test', 'is_active' => true]);
        $this->admin->givePermissionTo(['book.read', 'book.create', 'book.update', 'author.read', 'author.update', 'genre.read']);
        $caller = User::factory()->create(['username' => 'caller']);
        $caller->assignRole('authenticated');
        $this->jwt = $caller->createToken('api')->plainTextToken;
    }

    private function inAdmin(): void
    {
        // An API request leaves its guard the default; the admin signs in on the admin guard.
        $this->actingAs($this->admin, 'admin');
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

    /**
     * Strapi's edit view shows a relation's other side too: an author's books are picked on the
     * author, each one picked going to the end of its list, and one taken off is unlinked.
     */
    public function test_an_authors_books_are_picked_on_the_author_in_the_order_picked(): void
    {
        $ann = Author::create(['name' => 'Ann']);
        $bob = Author::create(['name' => 'Bob']);
        $this->api('POST', '/books', ['data' => ['title' => 'One', 'author' => $ann->document_id]]);
        $two = Book::create(['title' => 'Two']);
        $three = Book::create(['title' => 'Three', 'author_id' => $bob->getKey()]);
        $one = Book::query()->where('title', 'One')->sole();
        $this->inAdmin();

        Livewire::test(EditAuthor::class, ['record' => $ann->getRouteKey()])
            ->assertFormSet(['books' => [$one->getKey()]])
            ->fillForm(['books' => [$one->getKey(), $three->getKey(), $two->getKey()]])
            ->call('save')
            ->assertHasNoFormErrors();
        $read = $this->api('GET', "/authors/{$ann->document_id}?populate=books");
        // A book picked from another author moves, as a one-to-many link does in Strapi.
        $this->assertSame(['One', 'Three', 'Two'], array_column($read['books'], 'title'));
        $this->assertSame([], $this->api('GET', "/authors/{$bob->document_id}?populate=books")['books']);

        $this->inAdmin();
        Livewire::test(EditAuthor::class, ['record' => $ann->getRouteKey()])
            ->assertFormSet(['books' => [$one->getKey(), $three->getKey(), $two->getKey()]])
            ->fillForm(['books' => [$three->getKey()]])
            ->call('save')
            ->assertHasNoFormErrors();
        $this->assertSame(['Three'], array_column($this->api('GET', "/authors/{$ann->document_id}?populate=books")['books'], 'title'));
        $this->assertNull($one->fresh()->author_id);
        // Linking from the author changes the link, not the book.
        $this->assertSame($two->updated_at?->toJSON(), $two->fresh()->updated_at?->toJSON());
    }

    public function test_an_authors_books_are_not_linked_without_the_authors_update_grant(): void
    {
        $this->admin->revokePermissionTo('author.update');
        $ann = Author::create(['name' => 'Ann']);
        $this->inAdmin();
        Livewire::test(EditAuthor::class, ['record' => $ann->getRouteKey()])->assertForbidden();
    }
}
