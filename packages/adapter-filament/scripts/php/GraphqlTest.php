<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Book;
use App\Models\File;
use App\Models\Note;
use App\Models\Post;
use App\Models\User;
use App\Support\StrapiApiTokens;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Spatie\Permission\Models\Role;
use Tests\TestCase;

/**
 * The generated GraphQL endpoint (the strapi-api fixture with `graphql: true`), on the paths
 * graphql-vectors.json, which runs as a caller granted everything, does not reach: a caller the
 * IR grants nothing is refused, and a row condition hides another caller's rows from queries and
 * mutations alike. CI copies this into the scaffolded app's tests/Feature.
 */
class GraphqlTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    private function graphql(string $query, ?string $jwt = null): TestResponse
    {
        $headers = $jwt === null ? [] : ['Authorization' => 'Bearer '.$jwt];
        // One test, several callers: the guard would otherwise keep the first one it resolved.
        $this->app['auth']->forgetGuards();

        return $this->postJson('/graphql', ['query' => $query], $headers)->assertOk();
    }

    private function signIn(string $username): string
    {
        $user = User::factory()->create(['username' => $username]);
        $user->assignRole('authenticated');

        return $user->createToken('api')->plainTextToken;
    }

    public function test_a_caller_without_the_grant_is_refused_and_nothing_is_written(): void
    {
        // The public role reads books, and nothing else.
        $this->graphql('{ books { title } }')->assertJsonPath('data.books', []);
        $this->graphql('{ posts { title } }')
            ->assertJsonPath('errors.0.extensions.code', 'FORBIDDEN')
            ->assertJsonPath('errors.0.message', 'Forbidden access')
            ->assertJsonPath('errors.0.path', ['posts']);
        $this->graphql('mutation { createBook(data: { title: "Nope" }) { title } }')
            ->assertJsonPath('data.createBook', null)
            ->assertJsonPath('errors.0.extensions.code', 'FORBIDDEN');
        $this->assertSame(0, Book::count());
    }

    public function test_a_row_condition_hides_another_callers_rows(): void
    {
        $ann = $this->signIn('ann');
        $bob = $this->signIn('bob');
        $made = $this->graphql('mutation { createNote(data: { recordId: "n1", text: "Ann\'s", occurredAt: "2024-05-01T10:00:00.000Z" }) { documentId text } }', $ann)
            ->assertJsonPath('data.createNote.text', "Ann's")
            ->json('data.createNote.documentId');

        $this->graphql('{ notes { text } }', $ann)->assertJsonPath('data.notes', [['text' => "Ann's"]]);
        $this->graphql('{ notes { text } }', $bob)->assertJsonPath('data.notes', []);
        $this->graphql("{ note(documentId: \"{$made}\") { text } }", $bob)->assertJsonPath('data.note', null);
        $this->graphql("mutation { updateNote(documentId: \"{$made}\", data: { text: \"Bob's\" }) { text } }", $bob)
            ->assertJsonPath('data.updateNote', null);
        $this->graphql("mutation { deleteNote(documentId: \"{$made}\") { documentId } }", $bob);
        $this->assertSame("Ann's", Note::sole()->text);

        // Notes are keyed by recordId on REST; GraphQL still names them by documentId.
        $this->graphql("mutation { updateNote(documentId: \"{$made}\", data: { text: \"Edited\" }) { text } }", $ann)
            ->assertJsonPath('data.updateNote.text', 'Edited');
    }

    public function test_a_token_that_does_not_verify_is_answered_with_strapis_error_body(): void
    {
        $this->postJson('/graphql', ['query' => '{ books { title } }'], ['Authorization' => 'Bearer nope'])
            ->assertUnauthorized()
            ->assertJsonPath('error.name', 'UnauthorizedError');
    }

    public function test_roles_are_the_projects_own_and_no_token_changes_them(): void
    {
        $full = StrapiApiTokens::create(['name' => 'admin', 'type' => 'full-access'])['accessKey'];
        $roles = Role::query()->pluck('name')->sort()->values()->all();
        $public = Role::findByName('public')->getKey();

        $this->graphql('mutation { createUsersPermissionsRole(data: { name: "Editor" }) { ok } }', $full)
            ->assertJsonPath('data.createUsersPermissionsRole', null)
            ->assertJsonPath('errors.0.extensions.code', 'FORBIDDEN');
        $this->graphql("mutation { updateUsersPermissionsRole(id: \"{$public}\", data: { name: \"Everyone\" }) { ok } }", $full)
            ->assertJsonPath('errors.0.extensions.code', 'FORBIDDEN');
        $this->graphql("mutation { deleteUsersPermissionsRole(id: \"{$public}\") { ok } }", $full)
            ->assertJsonPath('errors.0.extensions.code', 'FORBIDDEN');
        $this->assertSame($roles, Role::query()->pluck('name')->sort()->values()->all());

        // A role's permissions are its grants in the IR, which permission rows cannot express.
        $this->graphql('{ usersPermissionsRoles { name permissions { action } } }', $full)
            ->assertJsonPath('errors.0.extensions.code', 'BAD_USER_INPUT')
            ->assertJsonPath('errors.0.path', ['usersPermissionsRoles', 0, 'permissions']);
    }

    public function test_signing_in_through_graphql_is_throttled_as_the_rest_route_is(): void
    {
        config(['camis.auth_throttle_per_minute' => 2]);
        $login = 'mutation { login(input: { identifier: "nobody", password: "wrong" }) { jwt } }';

        $this->graphql($login)->assertJsonPath('errors.0.extensions.code', 'BAD_USER_INPUT');
        $this->graphql($login)->assertJsonPath('errors.0.extensions.code', 'BAD_USER_INPUT');
        $this->graphql($login)
            ->assertJsonPath('errors.0.extensions.code', 'STRAPI_RATE_LIMIT_ERROR')
            ->assertJsonPath('errors.0.message', 'Too many requests, please try again later.');
    }

    public function test_a_custom_token_reaches_only_the_actions_it_was_given(): void
    {
        $books = StrapiApiTokens::create(['name' => 'books', 'type' => 'custom', 'permissions' => ['api::book.book.find']])['accessKey'];
        Book::query()->forceCreate(['title' => 'Alpha', 'document_id' => 'alpha0000000000000000000']);

        $this->graphql('{ books { title } }', $books)->assertJsonPath('data.books', [['title' => 'Alpha']]);
        $this->graphql('mutation { createBook(data: { title: "Nope" }) { title } }', $books)
            ->assertJsonPath('errors.0.extensions.code', 'FORBIDDEN');
        $this->graphql('{ me { username } }', $books)->assertJsonPath('errors.0.extensions.code', 'FORBIDDEN');
        $this->assertSame(1, Book::count());
    }

    /** strapi-php answers UploadFile.related with an internal error; this is the REST populate's answer. */
    public function test_a_files_related_entries_are_those_the_caller_may_read(): void
    {
        $file = File::query()->forceCreate(['name' => 'wide.png', 'hash' => 'wide', 'mime' => 'image/png', 'size' => 1.5, 'url' => '/uploads/wide.png', 'provider' => 'local']);
        $book = Book::query()->forceCreate(['title' => 'Covered', 'document_id' => 'covered00000000000000000']);
        $book->cover()->attach($file->getKey(), ['order' => 1]);
        $post = Post::query()->forceCreate(['title' => 'Pictured', 'document_id' => 'pictured0000000000000000']);
        $post->image()->attach($file->getKey(), ['order' => 1]);
        $query = '{ uploadFiles { name related { __typename ... on Book { title } ... on Post { title } } } }';

        $full = StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access'])['accessKey'];
        $this->graphql($query, $full)->assertJsonPath('data.uploadFiles.0.related', [
            ['__typename' => 'Book', 'title' => 'Covered'],
            ['__typename' => 'Post', 'title' => 'Pictured'],
        ]);

        $books = StrapiApiTokens::create(['name' => 'books', 'type' => 'custom', 'permissions' => ['plugin::upload.content-api.find', 'api::book.book.find']])['accessKey'];
        $this->graphql($query, $books)->assertJsonPath('data.uploadFiles.0.related', [['__typename' => 'Book', 'title' => 'Covered']]);
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/upload/files?populate=related', ['Authorization' => 'Bearer '.$books])
            ->assertOk()
            ->assertJsonPath('0.related.0.__type', 'api::book.book')
            ->assertJsonCount(1, '0.related');
    }
}
