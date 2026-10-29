<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Books\Pages\CreateBook;
use App\Filament\Resources\Files\Pages\CreateFile;
use App\Filament\Resources\Files\Pages\EditFile;
use App\Filament\Resources\Files\Pages\ListFiles;
use App\Filament\Resources\UploadFolders\Pages\CreateUploadFolder;
use App\Filament\Resources\UploadFolders\Pages\EditUploadFolder;
use App\Filament\Resources\UploadFolders\Pages\ListUploadFolders;
use App\Models\Book;
use App\Models\File;
use App\Models\UploadFolder;
use App\Models\User;
use App\Support\StrapiApiTokens;
use App\Support\StrapiExport;
use App\Support\StrapiFolders;
use App\Support\StrapiImport;
use App\Support\StrapiUpload;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The media library's folders, as Strapi's upload plugin keeps them (`upload_folders`, a file's
 * folder and folderPath): API uploads land in "API Uploads"; the admin makes, renames, moves and
 * deletes folders and moves files between them; an export carries them and an import restores
 * them. And a media field's allowedTypes, which Strapi's admin enforces when picking or uploading
 * (its Content API does not). CI copies this into the scaffolded app's tests/Feature.
 */
class FoldersTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        foreach ($permissions as $permission) {
            \Spatie\Permission\Models\Permission::findOrCreate($permission);
        }
        $user = User::factory()->create(['username' => 'admin', 'email' => 'admin@example.test']);
        $user->givePermissionTo($permissions);
        $this->actingAs($user);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    private function upload(string $name, ?UploadFolder $folder = null): File
    {
        $path = tempnam(sys_get_temp_dir(), 'media');
        file_put_contents($path, "hello {$name}\n");

        return StrapiUpload::storePath($path, $name, $folder === null ? [] : ['folder' => $folder->getKey()]);
    }

    private function image(string $name): File
    {
        $upload = UploadedFile::fake()->image($name, 10, 10);

        return StrapiUpload::storePath($upload->getRealPath(), $name, []);
    }

    public function test_api_uploads_land_in_the_api_uploads_folder(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        // A folder the admin named so already is not the API's: Strapi names its own "API Uploads (1)".
        StrapiFolders::create('API Uploads', null);
        $token = StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access'])['accessKey'];

        foreach (['one.txt', 'two.txt'] as $name) {
            $this->app['auth']->forgetGuards();
            $this->post('/api/upload', ['files' => UploadedFile::fake()->createWithContent($name, 'x')], ['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json'])
                ->assertCreated()
                ->assertJsonMissingPath('0.folder')
                ->assertJsonMissingPath('0.folderPath');
        }

        $folder = UploadFolder::query()->where('name', 'API Uploads (1)')->sole();
        $this->assertSame('/2', $folder->path);
        $this->assertSame(['/2', '/2'], File::query()->orderBy('id')->pluck('folder_path')->all());
        $this->assertSame([$folder->getKey(), $folder->getKey()], File::query()->orderBy('id')->pluck('folder_id')->all());
    }

    public function test_folders_nest_by_path_and_their_names_are_checked(): void
    {
        $this->login(['file.read', 'file.create', 'file.update', 'file.delete']);
        Livewire::test(CreateUploadFolder::class)->fillForm(['name' => 'Photos'])->call('create')->assertHasNoFormErrors();
        $photos = UploadFolder::query()->sole();
        Livewire::test(CreateUploadFolder::class)->fillForm(['name' => '2024', 'parent_id' => $photos->getKey()])->call('create')->assertHasNoFormErrors();
        $year = UploadFolder::query()->where('name', '2024')->sole();

        $this->assertSame([1, '/1', null], [$photos->path_id, $photos->path, $photos->parent_id]);
        $this->assertSame([2, '/1/2', $photos->getKey()], [$year->path_id, $year->path, $year->parent_id]);
        $this->assertSame('Photos / 2024', StrapiFolders::options()[$year->getKey()]);

        foreach (['a/b' => 'name cannot contain slashes', ' padded' => 'name cannot start or end with a whitespace', 'Photos' => 'A folder with this name already exists'] as $name => $message) {
            Livewire::test(CreateUploadFolder::class)->fillForm(['name' => $name])->call('create')->assertHasFormErrors(['name']);
            $this->assertSame($message, StrapiFolders::problem(null, $name, null));
        }
        // The same name under another parent is another folder.
        $this->assertNull(StrapiFolders::problem(null, '2024', null));
        $this->assertSame('folder cannot be moved inside itself', StrapiFolders::problem($photos, 'Photos', $year->getKey()));
        $this->assertSame('parent folder does not exist', StrapiFolders::problem(null, 'New', 999));
        Livewire::test(ListUploadFolders::class)->assertCanSeeTableRecords([$photos, $year]);
    }

    public function test_moving_a_folder_moves_what_it_holds(): void
    {
        $this->login(['file.read', 'file.create', 'file.update', 'file.delete']);
        $photos = StrapiFolders::create('Photos', null);
        $year = StrapiFolders::create('2024', $photos->getKey());
        $archive = StrapiFolders::create('Archive', null);
        $file = $this->upload('beach.txt', $year);
        $this->assertSame(['/1/2', $year->getKey()], [$file->folder_path, $file->folder_id]);

        Livewire::test(EditUploadFolder::class, ['record' => $photos->getKey()])
            ->fillForm(['name' => 'Pictures', 'parent_id' => $archive->getKey()])
            ->call('save')
            ->assertHasNoFormErrors();

        $this->assertSame(['Pictures', '/3/1'], [$photos->refresh()->name, $photos->path]);
        $this->assertSame('/3/1/2', $year->refresh()->path);
        $this->assertSame('/3/1/2', $file->refresh()->folder_path);
        $this->assertSame('Archive / Pictures / 2024', StrapiFolders::options()[$year->getKey()]);
        // A folder cannot go inside itself, nor be picked as its own parent.
        $this->assertArrayNotHasKey($year->getKey(), StrapiFolders::options($photos));
        Livewire::test(EditUploadFolder::class, ['record' => $photos->getKey()])
            ->fillForm(['parent_id' => $year->getKey()])
            ->call('save')
            ->assertHasFormErrors(['parent_id']);
    }

    public function test_files_move_between_folders_in_the_admin(): void
    {
        $this->login(['file.read', 'file.create', 'file.update', 'file.delete']);
        $photos = StrapiFolders::create('Photos', null);
        [$one, $two] = [$this->upload('one.txt'), $this->upload('two.txt')];
        $this->assertSame(['/', null], [$one->folder_path, $one->folder_id]);

        Livewire::test(ListFiles::class)
            ->callTableBulkAction('move', [$one, $two], data: ['folder_id' => $photos->getKey()])
            ->assertHasNoTableBulkActionErrors();
        $this->assertSame([[$photos->getKey(), '/1'], [$photos->getKey(), '/1']], File::query()->orderBy('id')->get()->map(fn (File $f) => [$f->folder_id, $f->folder_path])->all());

        Livewire::test(ListFiles::class)
            ->filterTable('folder', $photos->getKey())
            ->assertCanSeeTableRecords([$one, $two]);
        Livewire::test(EditFile::class, ['record' => $one->getKey()])
            ->fillForm(['folder_id' => null])
            ->call('save')
            ->assertHasNoFormErrors();
        $this->assertSame([null, '/'], [$one->refresh()->folder_id, $one->folder_path]);

        Livewire::test(CreateFile::class)
            ->fillForm(['upload' => UploadedFile::fake()->createWithContent('three.txt', 'x'), 'folder_id' => $photos->getKey()])
            ->call('create')
            ->assertHasNoFormErrors();
        $this->assertSame('/1', File::query()->where('name', 'three.txt')->sole()->folder_path);
    }

    public function test_deleting_a_folder_deletes_its_folders_and_files(): void
    {
        $this->login(['file.read', 'file.create', 'file.update', 'file.delete']);
        $photos = StrapiFolders::create('Photos', null);
        $year = StrapiFolders::create('2024', $photos->getKey());
        $kept = StrapiFolders::create('Kept', null);
        $inside = $this->upload('inside.txt', $year);
        $outside = $this->upload('outside.txt', $kept);

        Livewire::test(ListUploadFolders::class)->callTableAction('delete', $photos);

        $this->assertSame([$kept->getKey()], UploadFolder::query()->pluck('id')->all());
        $this->assertSame([$outside->getKey()], File::query()->pluck('id')->all());
        $this->assertFileDoesNotExist(public_path(ltrim($inside->url, '/')));
    }

    public function test_folders_are_read_with_the_file_read_grant_and_changed_with_the_others(): void
    {
        $this->login(['book.read', 'file.read']);
        Livewire::test(ListUploadFolders::class)->assertOk();
        Livewire::test(CreateUploadFolder::class)->assertForbidden();
    }

    public function test_folders_are_denied_without_the_file_grants(): void
    {
        $this->login(['book.read']);
        Livewire::test(ListUploadFolders::class)->assertForbidden();
    }

    public function test_an_export_carries_the_folders_and_an_import_restores_them(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $photos = StrapiFolders::create('Photos', null);
        $year = StrapiFolders::create('2024', $photos->getKey());
        $this->upload('beach.txt', $year);
        $api = StrapiFolders::apiUploads();
        $archive = StrapiExport::write(sys_get_temp_dir().'/camis-folders-'.bin2hex(random_bytes(4)), StrapiExport::STAGES, true, null)['path'];

        UploadFolder::query()->delete();
        File::query()->update(['folder_id' => null, 'folder_path' => '/']);
        $import = StrapiImport::open($archive, null);
        $import->run(StrapiImport::STAGES);
        unlink($archive);

        $folders = UploadFolder::query()->orderBy('path_id')->get();
        $this->assertSame([['Photos', 1, '/1', null], ['2024', 2, '/1/2', 'Photos'], ['API Uploads', 3, '/3', null]], $folders->map(fn (UploadFolder $f) => [$f->name, $f->path_id, $f->path, $f->parent?->name])->all());
        $file = File::query()->sole();
        $this->assertSame(['2024', '/1/2'], [$file->folder?->name, $file->folder_path]);
        $this->assertSame($api->document_id, StrapiFolders::apiUploads()->document_id);
    }

    public function test_a_media_field_takes_only_its_allowed_types_in_the_admin(): void
    {
        $this->login(['book.read', 'book.create', 'file.read', 'file.create']);
        $notes = $this->upload('notes.txt');
        $photo = $this->image('photo.png');

        // Book's cover allows images; its attachments allow any file.
        Livewire::test(CreateBook::class)
            ->fillForm(['title' => 'Dune', 'cover' => [$notes->getKey()]])
            ->call('create')
            ->assertHasFormErrors(['cover']);
        Livewire::test(CreateBook::class)
            ->fillForm(['title' => 'Dune', 'cover' => [$photo->getKey()], 'attachments' => [$notes->getKey(), $photo->getKey()]])
            ->call('create')
            ->assertHasNoFormErrors();
        $this->assertSame([$photo->getKey()], Book::sole()->cover()->pluck('files.id')->all());

        $this->assertSame('image', \App\Filament\Support\MediaPicker::kind('image/png'));
        $this->assertSame('file', \App\Filament\Support\MediaPicker::kind('application/pdf'));
        $this->assertTrue(\App\Filament\Support\MediaPicker::allows(['image'], 'image/png'));
        $this->assertFalse(\App\Filament\Support\MediaPicker::allows(['image'], 'text/plain'));
        $this->assertTrue(\App\Filament\Support\MediaPicker::allows(['file'], 'text/plain'));
        $this->assertFalse(\App\Filament\Support\MediaPicker::allows(['file'], 'video/mp4'));
        $this->assertTrue(\App\Filament\Support\MediaPicker::allows(null, 'video/mp4'));
    }
}
