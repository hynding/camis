<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Pages\UsersPermissionsProviders;
use App\Models\User;
use App\Support\StrapiProviders;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated sign-in providers that oauth-vectors.json cannot reach, since their hosts are
 * fixed: each profile check against its provider's answer, Twitter's signed OAuth 1 requests,
 * and the providers' settings on the admin page. CI copies this into the scaffolded app's
 * tests/Feature.
 */
class ProvidersTest extends TestCase
{
    use RefreshDatabase;

    public function test_github_vouches_for_a_verified_primary_email_only(): void
    {
        Http::fake([
            'api.github.com/user' => Http::response(['login' => 'octo', 'email' => null]),
            'api.github.com/user/emails' => Http::response([['email' => 'octo@example.test', 'primary' => true, 'verified' => true]]),
        ]);
        $this->assertSame(['username' => 'octo', 'email' => 'octo@example.test'], StrapiProviders::profile('github', [], 'token-1'));
        Http::assertSent(fn (Request $request): bool => $request->hasHeader('Authorization', 'Bearer token-1') && $request->hasHeader('user-agent', 'strapi'));
    }

    public function test_github_refuses_a_public_email_it_did_not_verify(): void
    {
        Http::fake([
            'api.github.com/user' => Http::response(['login' => 'octo', 'email' => 'public@example.test']),
            'api.github.com/user/emails' => Http::response([['email' => 'public@example.test', 'primary' => false, 'verified' => false]]),
        ]);
        $this->expectExceptionMessage('Email not verified by GitHub');
        StrapiProviders::profile('github', [], 'token-1');
    }

    public function test_google_and_discord_answer_in_their_own_shapes(): void
    {
        Http::fake([
            'oauth2.googleapis.com/tokeninfo*' => Http::response(['email' => 'g.user@example.test', 'email_verified' => 'true']),
            'discord.com/api/users/@me' => Http::response(['username' => 'wumpus', 'discriminator' => '0042', 'email' => 'w@example.test', 'verified' => true]),
        ]);
        $this->assertSame(['username' => 'g.user', 'email' => 'g.user@example.test'], StrapiProviders::profile('google', [], 'a b'));
        Http::assertSent(fn (Request $request): bool => $request->url() === 'https://oauth2.googleapis.com/tokeninfo?access_token=a%20b');
        $this->assertSame(['username' => 'wumpus#0042', 'email' => 'w@example.test'], StrapiProviders::profile('discord', [], 'token'));
    }

    public function test_a_twitter_round_trip_signs_its_requests_with_oauth_1(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        StrapiProviders::configure('twitter', ['enabled' => true, 'key' => 'consumer', 'secret' => 'shh', 'callback' => 'http://frontend.test/twitter']);
        Http::fake([
            'api.twitter.com/oauth/request_token' => Http::response('oauth_token=req&oauth_token_secret=req-secret&oauth_callback_confirmed=true', 200, ['Content-Type' => 'application/x-www-form-urlencoded']),
            'api.twitter.com/oauth/access_token' => Http::response('oauth_token=acc&oauth_token_secret=acc-secret&screen_name=jack', 200, ['Content-Type' => 'application/x-www-form-urlencoded']),
            'api.twitter.com/1.1/account/verify_credentials.json*' => Http::response(['screen_name' => 'jack', 'email' => 'jack@example.test']),
        ]);

        $this->get('/api/connect/twitter')->assertRedirect('https://api.twitter.com/oauth/authenticate?oauth_token=req');
        Http::assertSent(fn (Request $request): bool => str_starts_with($request->header('Authorization')[0] ?? '', 'OAuth ')
            && str_contains($request->header('Authorization')[0], 'oauth_callback="'.rawurlencode(config('app.url').'/api/connect/twitter/callback').'"')
            && str_contains($request->header('Authorization')[0], 'oauth_signature_method="HMAC-SHA1"'));

        $this->get('/api/connect/twitter/callback?oauth_token=req&oauth_verifier=v')->assertRedirect('http://frontend.test/twitter');
        $this->getJson('/api/auth/twitter/callback')->assertOk()->assertJsonPath('user.username', 'jack')->assertJsonPath('user.provider', 'twitter');
        Http::assertSent(fn (Request $request): bool => str_contains($request->url(), 'verify_credentials.json?include_email=true&screen_name=jack')
            && str_contains($request->header('Authorization')[0] ?? '', 'oauth_token="acc"'));
        $this->assertNull(User::where('username', 'jack')->sole()->password);
    }

    public function test_a_token_for_another_request_ends_the_twitter_round_trip(): void
    {
        StrapiProviders::configure('twitter', ['enabled' => true, 'key' => 'consumer', 'secret' => 'shh', 'callback' => 'http://frontend.test/twitter']);
        Http::fake(['api.twitter.com/oauth/request_token' => Http::response('oauth_token=req&oauth_token_secret=s', 200)]);
        $this->get('/api/connect/twitter');

        $this->get('/api/connect/twitter/callback?oauth_token=forged&oauth_verifier=v')
            ->assertRedirect('http://frontend.test/twitter?error=oauth_error&error_description=OAuth1+token+mismatch');
        Http::assertSentCount(1);
    }

    public function test_reddit_authenticates_its_token_request_with_basic_credentials(): void
    {
        StrapiProviders::configure('reddit', ['enabled' => true, 'key' => 'app', 'secret' => 'shh', 'callback' => 'http://frontend.test/reddit']);
        Http::fake(['ssl.reddit.com/api/v1/access_token' => Http::response(['access_token' => 'r-token'])]);
        $location = $this->get('/api/connect/reddit')->headers->get('Location');
        parse_str((string) parse_url((string) $location, PHP_URL_QUERY), $query);

        $this->get('/api/connect/reddit/callback?code=c&state='.$query['state'])->assertRedirect('http://frontend.test/reddit');
        Http::assertSent(fn (Request $request): bool => $request->hasHeader('Authorization', 'Basic '.base64_encode('app:shh'))
            && ! str_contains($request->body(), 'client_secret'));
    }

    public function test_the_admin_turns_a_provider_on_without_a_redeploy(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        \Spatie\Permission\Models\Permission::findOrCreate('user.update');
        $admin = User::factory()->create(['username' => 'admin']);
        $admin->givePermissionTo('user.update');
        $this->actingAs($admin);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        $this->assertFalse(StrapiProviders::enabled('github'));

        Livewire::test(UsersPermissionsProviders::class)
            ->fillForm(['grant.github.enabled' => true, 'grant.github.key' => 'client', 'grant.github.secret' => 'shh', 'grant.github.callback' => 'https://app.example.test/github'])
            ->call('save')
            ->assertHasNoFormErrors();

        $github = StrapiProviders::settings()['github'];
        $this->assertTrue(StrapiProviders::enabled('github'));
        $this->assertSame(['client', 'shh', 'https://app.example.test/github'], [$github['key'], $github['secret'], $github['callback']]);
        $this->assertSame(['user', 'user:email'], $github['scope'], 'what the form does not show keeps its default');
    }
}
