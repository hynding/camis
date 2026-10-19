<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Books\Pages\CreateBook;
use App\Filament\Resources\Files\Pages\CreateFile;
use App\Filament\Resources\Files\Pages\ListFiles;
use App\Models\Book;
use App\Models\File;
use App\Models\User;
use App\Support\StrapiUpload;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated Filament media library (the strapi-api fixture's builtin File): an admin upload is
 * stored as an API upload is, with its formats; a Book links its cover and attachments through the
 * media picker; and without the file grants the library is out of reach. CI copies this into the
 * scaffolded app's tests/Feature.
 */
class MediaAdminTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'admin']);
        $user->givePermissionTo($permissions);
        $this->actingAs($user);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    private function upload(string $name): File
    {
        $path = tempnam(sys_get_temp_dir(), 'media');
        file_put_contents($path, "hello {$name}\n");

        return StrapiUpload::storePath($path, $name, []);
    }

    public function test_an_admin_upload_is_stored_with_its_formats(): void
    {
        $this->login(['file.read', 'file.create']);
        Livewire::test(CreateFile::class)
            ->fillForm(['upload' => UploadedFile::fake()->image('Wide Shot.png', 1200, 800), 'caption' => 'A wide shot'])
            ->call('create')
            ->assertHasNoFormErrors();

        $file = File::sole();
        $this->assertSame('Wide Shot.png', $file->name);
        $this->assertSame('A wide shot', $file->caption);
        $this->assertSame(1200, $file->width);
        $this->assertMatchesRegularExpression('#^/uploads/Wide_Shot_[0-9a-f]{10}\.png$#', $file->url);
        $this->assertEqualsCanonicalizing(['large', 'medium', 'small', 'thumbnail'], array_keys($file->formats));
        $this->assertFileExists(public_path(ltrim($file->url, '/')));
        Livewire::test(ListFiles::class)->assertCanSeeTableRecords([$file]);

        $file->delete();
        $this->assertFileDoesNotExist(public_path(ltrim($file->url, '/')));
    }

    public function test_a_book_links_its_cover_and_attachments(): void
    {
        $this->login(['book.read', 'book.create', 'file.read']);
        [$cover, $first, $second] = array_map($this->upload(...), ['cover.txt', 'first.txt', 'second.txt']);

        Livewire::test(CreateBook::class)
            ->fillForm(['title' => 'Dune', 'cover' => [$cover->getKey()], 'attachments' => [$second->getKey(), $first->getKey()]])
            ->call('create')
            ->assertHasNoFormErrors();

        $book = Book::sole();
        $this->assertSame([$cover->getKey()], $book->cover()->pluck('files.id')->all());
        $this->assertEqualsCanonicalizing([$first->getKey(), $second->getKey()], $book->attachments()->pluck('files.id')->all());

        $book->delete();
        $this->assertDatabaseCount('files_related_mph', 0);
        $this->assertDatabaseCount('files', 3);
    }

    public function test_the_library_is_denied_without_the_file_grants(): void
    {
        $this->login(['book.read']);
        Livewire::test(ListFiles::class)->assertForbidden();
        Livewire::test(CreateFile::class)->assertForbidden();
    }
}
