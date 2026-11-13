<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Memo;
use App\Models\User;
use App\Support\StrapiApiTokens;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Strapi's route auth: false (the author-role fixture's Memo list and read): anyone reaches them,
 * with no session, a bad one, or a token that was given nothing, and no role is asked for a grant,
 * while the type's other routes still are. CI's author-role job copies this into tests/Feature.
 */
class PublicActionsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    /** A request with this bearer alone, as a client of the API sends it. */
    private function asClient(string $key): static
    {
        $this->app['auth']->forgetGuards();

        return $this->withHeader('Authorization', 'Bearer '.$key);
    }

    public function test_anyone_lists_and_reads_a_public_type_without_credentials(): void
    {
        $memo = Memo::create(['title' => 'Open']);

        $this->getJson('/api/memos')->assertOk()->assertJsonPath('data.0.title', 'Open');
        $this->getJson('/api/memos/'.$memo->document_id)->assertOk()->assertJsonPath('data.title', 'Open');
    }

    public function test_a_credential_is_not_even_read_on_a_public_route(): void
    {
        Memo::create(['title' => 'Open']);
        $this->asClient('not-a-token')->getJson('/api/memos')->assertOk();

        // A custom token given nothing on memos still reads them, as Strapi never checks it there.
        $made = StrapiApiTokens::create(['name' => 'stories', 'type' => 'custom', 'permissions' => ['api::story.story.find']]);
        $this->asClient($made['accessKey'])->getJson('/api/memos')->assertOk();
        $this->asClient($made['accessKey'])->postJson('/api/memos', ['data' => ['title' => 'No']])->assertForbidden();
    }

    public function test_the_type_s_other_routes_still_ask_the_caller_s_role(): void
    {
        // camis answers a caller without a session 401 where no public role is served, Strapi 403.
        $this->assertContains($this->postJson('/api/memos', ['data' => ['title' => 'No']])->status(), [401, 403]);
        $user = User::factory()->create(['username' => 'reader']);
        $user->assignRole('authenticated');
        $jwt = $user->createToken('api')->plainTextToken;

        // The authenticated role holds no grant on memos: it reads them only where they are open.
        $this->asClient($jwt)->getJson('/api/memos')->assertOk();
        $this->asClient($jwt)->postJson('/api/memos', ['data' => ['title' => 'No']])->assertForbidden();
        $this->assertSame(0, Memo::count());
    }
}
