<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Hooks\Contracts\MemoCountEndpoint;
use App\Hooks\Contracts\MemoPinEndpoint;
use App\Hooks\MemoCount;
use App\Hooks\MemoPin;
use App\Models\Memo;
use App\Models\User;
use App\Support\StrapiApiTokens;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Tests\TestCase;

/**
 * IR endpoints, Strapi's custom routes (the author-role fixture's MemoPin, which the authenticated
 * role lists, and the public MemoCount): the route reaches its hand-written handler with the path's
 * params, only for a role that lists it, and a public one for anyone. CI's author-role job copies
 * this into tests/Feature.
 */
class EndpointsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        // The handlers a project writes in place of the seeded ones.
        $this->app->bind(MemoPin::class, fn () => new class implements MemoPinEndpoint {
            public function handle(Request $request): mixed
            {
                return ['data' => ['pinned' => $request->route('id'), 'by' => $request->user()?->username]];
            }
        });
        $this->app->bind(MemoCount::class, fn () => new class implements MemoCountEndpoint {
            public function handle(Request $request): mixed
            {
                return ['data' => Memo::count()];
            }
        });
    }

    /** A request with this bearer alone, as a client of the API sends it. */
    private function asClient(string $key): static
    {
        $this->app['auth']->forgetGuards();

        return $this->withHeader('Authorization', 'Bearer '.$key);
    }

    private function jwt(string $role): string
    {
        $user = User::factory()->create(['username' => $role]);
        $user->assignRole($role);

        return $user->createToken('api')->plainTextToken;
    }

    public function test_a_role_that_lists_an_endpoint_reaches_its_handler_with_the_path_s_params(): void
    {
        $this->asClient($this->jwt('authenticated'))->postJson('/api/memos/abc/pin')
            ->assertOk()->assertExactJson(['data' => ['pinned' => 'abc', 'by' => 'authenticated']]);
    }

    public function test_a_caller_whose_role_does_not_list_it_is_refused(): void
    {
        $this->assertContains($this->postJson('/api/memos/abc/pin')->status(), [401, 403]);
        \Spatie\Permission\Models\Role::findOrCreate('reader');
        $this->asClient($this->jwt('reader'))->postJson('/api/memos/abc/pin')
            ->assertForbidden()->assertJsonPath('error.name', 'ForbiddenError');
    }

    public function test_a_full_access_token_calls_it_and_a_read_only_one_does_not(): void
    {
        $full = StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access']);
        $this->asClient($full['accessKey'])->postJson('/api/memos/abc/pin')->assertOk();
        $read = StrapiApiTokens::create(['name' => 'read', 'type' => 'read-only']);
        $this->asClient($read['accessKey'])->postJson('/api/memos/abc/pin')->assertForbidden();
    }

    public function test_anyone_calls_a_public_endpoint_and_it_is_not_taken_for_a_memo_s_key(): void
    {
        Memo::create(['title' => 'One']);
        $this->getJson('/api/memos/count')->assertOk()->assertExactJson(['data' => 1]);
        $this->asClient('not-a-token')->getJson('/api/memos/count')->assertOk();
    }
}
