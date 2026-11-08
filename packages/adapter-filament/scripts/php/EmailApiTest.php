<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\User;
use App\Support\StrapiApiTokens;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Tests\TestCase;

/**
 * Strapi's email plugin's POST /api/email: no role Strapi ships holds plugin::email.email.send, so
 * the public and authenticated roles are forbidden, and an API token holding the action sends.
 * CI copies this into the scaffolded app's tests/Feature.
 */
class EmailApiTest extends TestCase
{
    use RefreshDatabase;

    private const MESSAGE = ['to' => 'reader@example.test', 'subject' => 'Hello', 'text' => 'Plain words', 'html' => '<p>Plain words</p>'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        config(['mail.default' => 'array', 'mail.from.address' => 'hello@example.test']);
    }

    private function asClient(string $key): static
    {
        $this->app['auth']->forgetGuards();

        return $this->withHeader('Authorization', 'Bearer '.$key);
    }

    /** @return list<\Symfony\Component\Mime\Email> */
    private function sent(): array
    {
        return Mail::mailer('array')->getSymfonyTransport()->messages()
            ->map(fn ($message) => $message->getOriginalMessage())->values()->all();
    }

    public function test_a_full_access_token_sends_and_gets_an_empty_object(): void
    {
        $made = StrapiApiTokens::create(['name' => 'mailer', 'type' => 'full-access']);

        $response = $this->asClient($made['accessKey'])->postJson('/api/email', self::MESSAGE + ['replyTo' => 'desk@example.test']);

        $response->assertOk();
        $this->assertSame('{}', $response->getContent());
        [$email] = $this->sent();
        $this->assertSame('reader@example.test', $email->getTo()[0]->getAddress());
        $this->assertSame('hello@example.test', $email->getFrom()[0]->getAddress());
        $this->assertSame('desk@example.test', $email->getReplyTo()[0]->getAddress());
        $this->assertSame('Hello', $email->getSubject());
        $this->assertSame('Plain words', $email->getTextBody());
        $this->assertSame('<p>Plain words</p>', $email->getHtmlBody());
    }

    public function test_a_custom_token_sends_only_with_the_send_action(): void
    {
        $sender = StrapiApiTokens::create(['name' => 'sender', 'type' => 'custom', 'permissions' => ['plugin::email.email.send']]);
        $reader = StrapiApiTokens::create(['name' => 'reader', 'type' => 'read-only']);

        $this->asClient($sender['accessKey'])->postJson('/api/email', self::MESSAGE)->assertOk();
        $this->asClient($reader['accessKey'])->postJson('/api/email', self::MESSAGE)
            ->assertForbidden()->assertJsonPath('error.name', 'ForbiddenError');
        $this->assertCount(1, $this->sent());
    }

    public function test_the_roles_strapi_ships_may_not_send(): void
    {
        $this->postJson('/api/email', self::MESSAGE)
            ->assertForbidden()->assertJsonPath('error.message', 'Forbidden');

        $user = User::factory()->create(['username' => 'ann']);
        $user->assignRole('authenticated');
        $this->asClient($user->createToken('api')->plainTextToken)->postJson('/api/email', self::MESSAGE)
            ->assertForbidden()->assertJsonPath('error.name', 'ForbiddenError');
        $this->assertSame([], $this->sent());
    }

    public function test_a_send_the_mailer_refuses_is_a_server_error(): void
    {
        $made = StrapiApiTokens::create(['name' => 'mailer', 'type' => 'full-access']);

        $this->asClient($made['accessKey'])->postJson('/api/email', ['subject' => 'Nobody', 'text' => 'to'])
            ->assertStatus(500)->assertJsonPath('error.name', 'InternalServerError');
    }
}
