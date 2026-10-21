<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Posts\Pages\CreatePost;
use App\Filament\Resources\Posts\Pages\EditPost;
use App\Filament\Resources\Webhooks\Pages\CreateWebhook;
use App\Filament\Resources\Webhooks\Pages\EditWebhook;
use App\Filament\Resources\Webhooks\Pages\ListWebhooks;
use App\Models\Author;
use App\Models\Post;
use App\Models\StrapiWebhook;
use App\Models\User;
use App\Support\StrapiWebhooks;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated webhooks beyond what webhook-vectors.json reaches: the admin's Webhooks page and
 * its trigger, Strapi's production url check, the admin's own writes and publication changes, a
 * write that rolls back, and the default headers. CI copies this into the scaffolded app's
 * tests/Feature.
 */
class WebhooksTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        foreach ($permissions as $permission) {
            \Spatie\Permission\Models\Permission::findOrCreate($permission);
        }
        $user = User::factory()->create(['username' => 'admin']);
        $user->givePermissionTo($permissions);
        $this->actingAs($user);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    private function hook(array $events, array $headers = []): StrapiWebhook
    {
        return StrapiWebhook::create(['name' => 'site', 'url' => 'https://example.test/hook', 'headers' => $headers, 'events' => $events]);
    }

    private int $seen = 0;

    /** @return list<string> the events sent since the last call, in order */
    private function sent(): array
    {
        StrapiWebhooks::flush();
        $events = Http::recorded()->map(fn (array $pair) => $pair[0]['event'])->values()->all();
        $new = array_slice($events, $this->seen);
        $this->seen = count($events);

        return $new;
    }

    public function test_a_webhook_made_on_the_admin_page_is_triggered_from_it(): void
    {
        Http::fake(['example.test/*' => Http::response('nope', 410)]);
        $this->login(['user.update']);
        Livewire::test(CreateWebhook::class)
            ->fillForm(['name' => 'site', 'url' => 'not a url', 'events' => ['entry.create']])
            ->call('create')
            ->assertHasFormErrors(['url']);
        Livewire::test(CreateWebhook::class)
            ->fillForm(['name' => 'site', 'url' => 'https://example.test/hook', 'headers' => ['X-Site' => 'blog'], 'events' => ['entry.create', 'media.delete']])
            ->call('create')
            ->assertHasNoFormErrors();
        $webhook = StrapiWebhook::sole();
        $this->assertSame(['X-Site' => 'blog'], $webhook->headers);
        $this->assertTrue($webhook->enabled);

        Livewire::test(EditWebhook::class, ['record' => $webhook->getRouteKey()])
            ->callAction('trigger')
            ->assertNotified('Error: 410');
        Http::assertSent(fn (Request $request) => $request['event'] === 'trigger-test' && $request->header('X-Strapi-Event') === ['trigger-test'] && $request->header('X-Site') === ['blog']);
    }

    public function test_production_refuses_a_url_the_public_internet_cannot_reach(): void
    {
        $this->login(['user.update']);
        $this->app['env'] = 'production';
        Livewire::test(CreateWebhook::class)
            ->fillForm(['name' => 'local', 'url' => 'http://127.0.0.1:9555/hook', 'events' => ['entry.create']])
            ->call('create')
            ->assertHasFormErrors(['url']);
        $this->assertSame(0, StrapiWebhook::count());
    }

    public function test_the_webhooks_are_out_of_reach_without_the_grant_to_change_accounts(): void
    {
        $this->login(['user.read']);
        Livewire::test(ListWebhooks::class)->assertForbidden();
    }

    public function test_the_admin_sends_what_the_api_sends(): void
    {
        Http::fake();
        $this->hook(StrapiWebhooks::EVENTS);
        $this->login(['post.create', 'post.read', 'post.update', 'post.publish']);
        $author = Author::create(['name' => 'Ann']);
        $this->assertSame(['entry.create'], $this->sent());

        Livewire::test(CreatePost::class)
            ->fillForm(['title' => 'One', 'author_id' => $author->id])
            ->call('create')
            ->assertHasNoFormErrors();
        $draft = Post::sole();
        $this->assertSame(['entry.create'], $this->sent());
        Http::assertSent(fn (Request $request) => ($request['entry']['author']['name'] ?? null) === 'Ann');

        $page = Livewire::test(EditPost::class, ['record' => $draft->getRouteKey()]);
        $page->callAction('publish');
        $this->assertSame(['entry.update', 'entry.publish'], $this->sent());
        $page->fillForm(['title' => 'edited'])->call('save');
        $page->callAction('discard');
        $page->callAction('unpublish');
        $this->assertSame(['entry.update', 'entry.draft-discard', 'entry.unpublish'], $this->sent());
        Http::assertSent(fn (Request $request) => $request['event'] === 'entry.unpublish' && $request['entry']['publishedAt'] !== null && ! isset($request['entry']['author']));
    }

    public function test_a_write_that_rolls_back_sends_nothing(): void
    {
        Http::fake();
        $this->hook(['entry.create']);
        try {
            DB::transaction(function (): void {
                Author::create(['name' => 'Ann']);
                throw new \RuntimeException('no');
            });
        } catch (\RuntimeException) {
        }
        $this->assertSame([], $this->sent());
    }

    public function test_a_disabled_webhook_or_one_deaf_to_the_event_hears_nothing(): void
    {
        Http::fake();
        $this->hook(['entry.update']);
        StrapiWebhook::create(['name' => 'off', 'url' => 'https://example.test/off', 'headers' => [], 'events' => ['entry.create'], 'enabled' => false]);
        Author::create(['name' => 'Ann']);
        $this->assertSame([], $this->sent());
    }

    public function test_every_webhook_sends_the_default_headers_under_its_own(): void
    {
        Http::fake();
        config(['camis.webhooks.default_headers' => ['Authorization' => 'Bearer shared', 'X-Site' => 'default']]);
        $this->hook(['entry.create'], ['X-Site' => 'blog']);
        Author::create(['name' => 'Ann']);
        $this->sent();
        Http::assertSent(fn (Request $request) => $request->header('Authorization') === ['Bearer shared'] && $request->header('X-Site') === ['blog'] && $request->header('Content-Type') === ['application/json']);
    }
}
