<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Book;
use App\Models\Note;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
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
}
