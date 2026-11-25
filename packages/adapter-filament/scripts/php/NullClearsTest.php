<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\BrandKit;
use App\Models\File;
use App\Models\Partner;
use App\Models\Profile;
use App\Models\User;
use App\Support\StrapiUpload;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * An explicit null in a write (the null-clears fixture, issue #122), answered as Strapi answers it:
 * on an update it clears an optional field, unlinks a link and clears a component, while a key the
 * body leaves out keeps its value; a required field, a repeatable and a dynamic zone refuse it; a
 * field the grant assigns stays the caller's. CI's null-clears job copies this into the scaffolded
 * app's tests/Feature, once per database.
 */
class NullClearsTest extends TestCase
{
    use RefreshDatabase;

    /** BrandKit's required component, which every create sends. */
    private const IDENTITY = ['identity' => ['mark' => 'M']];

    private User $user;

    private string $jwt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $this->user = User::factory()->create(['username' => 'maker']);
        $this->user->assignRole('authenticated');
        $this->jwt = $this->user->createToken('api')->plainTextToken;
    }

    /** @param array<string, mixed>|null $data */
    private function api(string $method, string $uri, ?array $data = null): TestResponse
    {
        $this->app['auth']->forgetGuards();

        return $this->withHeader('Authorization', 'Bearer '.$this->jwt)->json($method, '/api/'.$uri, $data === null ? [] : ['data' => $data]);
    }

    /** @param array<string, mixed> $data */
    private function make(array $data): string
    {
        return $this->api('POST', 'brand-kits', ['title' => 'Kit', ...self::IDENTITY, ...$data])->assertCreated()->json('data.documentId');
    }

    private function show(string $documentId): TestResponse
    {
        return $this->api('GET', "brand-kits/{$documentId}?populate=*")->assertOk();
    }

    private function logo(string $name): File
    {
        $upload = UploadedFile::fake()->image($name, 10, 10);

        return StrapiUpload::storePath($upload->getRealPath(), $name, []);
    }

    /** @param list<string> $path */
    private function assertRefused(TestResponse $response, array $path, string $message): void
    {
        $response->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')
            ->assertJsonPath('error.details.errors.0.path', $path)
            ->assertJsonPath('error.details.errors.0.message', $message);
    }

    public function test_null_clears_an_optional_scalar_of_each_common_kind_and_a_missing_key_keeps_its_value(): void
    {
        $id = $this->make([
            'tagline' => 'Bold', 'notes' => 'Long', 'code' => 'ABC', 'rank' => 3, 'share' => '1.5', 'active' => true,
            'launchedOn' => '2026-01-02', 'seenAt' => '1700000000000',
        ]);

        $this->api('PUT', "brand-kits/{$id}", ['tagline' => null, 'notes' => null, 'rank' => null, 'share' => null, 'active' => null])
            ->assertOk()
            ->assertJsonPath('data.tagline', null)
            ->assertJsonPath('data.notes', null)
            ->assertJsonPath('data.rank', null)
            ->assertJsonPath('data.share', null)
            ->assertJsonPath('data.active', null)
            ->assertJsonPath('data.code', 'ABC')
            ->assertJsonPath('data.launchedOn', '2026-01-02')
            ->assertJsonPath('data.title', 'Kit')
            ->assertJsonPath('data.tone', 'plain');
        $this->api('PUT', "brand-kits/{$id}", ['launchedOn' => null, 'seenAt' => null, 'code' => null, 'tone' => null])
            ->assertOk()
            ->assertJsonPath('data.launchedOn', null)
            ->assertJsonPath('data.seenAt', null)
            ->assertJsonPath('data.code', null)
            ->assertJsonPath('data.tone', null);
        $this->show($id)->assertJsonPath('data.title', 'Kit')->assertJsonPath('data.tagline', null);
    }

    public function test_null_clears_the_other_kinds_of_optional_scalar(): void
    {
        $values = [
            'body' => '# Hi', 'contact' => 'a@b.co', 'mood' => 'calm', 'meta' => ['k' => 'v'],
            'story' => [['type' => 'paragraph', 'children' => [['type' => 'text', 'text' => 'Once']]]],
            'ratio' => 0.5, 'reach' => '9007199254740993', 'startsAt' => '2026-01-02T03:04:05.000Z', 'opensAt' => '09:30:00.000',
        ];
        $id = $this->make($values);
        $made = $this->show($id);
        foreach ($values as $key => $value) {
            $this->assertNotNull($made->json("data.{$key}"), $key);
        }

        $cleared = $this->api('PUT', "brand-kits/{$id}", array_map(fn (mixed $value) => null, $values))->assertOk();
        foreach (array_keys($values) as $key) {
            $cleared->assertJsonPath("data.{$key}", null);
        }
        $shown = $this->show($id);
        foreach (array_keys($values) as $key) {
            $shown->assertJsonPath("data.{$key}", null);
        }
    }

    public function test_a_key_the_body_leaves_out_keeps_its_value(): void
    {
        $id = $this->make(['tagline' => 'Bold', 'rank' => 3, 'seo' => ['headline' => 'H', 'summary' => 'S']]);

        $this->api('PUT', "brand-kits/{$id}", ['notes' => 'Added'])
            ->assertOk()
            ->assertJsonPath('data.tagline', 'Bold')
            ->assertJsonPath('data.rank', 3)
            ->assertJsonPath('data.notes', 'Added');
        $this->show($id)->assertJsonPath('data.seo.headline', 'H');
    }

    public function test_null_on_a_create_is_no_value_and_runs_no_validation(): void
    {
        $first = $this->api('POST', 'brand-kits', ['title' => 'One', ...self::IDENTITY, 'tagline' => null, 'code' => null, 'rank' => null, 'launchedOn' => null])
            ->assertCreated()
            ->assertJsonPath('data.tagline', null)
            ->assertJsonPath('data.code', null)
            ->assertJsonPath('data.rank', null);
        // A second null breaks neither the unique index nor the pattern, length and bounds.
        $this->api('POST', 'brand-kits', ['title' => 'Two', ...self::IDENTITY, 'code' => null, 'rank' => null])->assertCreated();
        $this->api('PUT', 'brand-kits/'.$first->json('data.documentId'), ['code' => null, 'rank' => null])->assertOk();
    }

    public function test_a_null_for_a_field_with_a_default_is_stored_as_null_not_the_default(): void
    {
        // Strapi's database layer takes a default for a key that is missing, not for a null.
        $this->api('POST', 'brand-kits', ['title' => 'A', ...self::IDENTITY])->assertCreated()->assertJsonPath('data.tone', 'plain');
        $this->api('POST', 'brand-kits', ['title' => 'B', ...self::IDENTITY, 'tone' => null])->assertCreated()->assertJsonPath('data.tone', null);
    }

    public function test_a_required_field_refuses_null_on_create_and_update(): void
    {
        $this->assertRefused(
            $this->api('POST', 'brand-kits', ['title' => null, ...self::IDENTITY]),
            ['title'],
            'title must be a `string` type, but the final value was: `null`.',
        );
        $id = $this->make([]);
        $this->assertRefused(
            $this->api('PUT', "brand-kits/{$id}", ['title' => null]),
            ['title'],
            'title must be a `string` type, but the final value was: `null`.',
        );
        $this->show($id)->assertJsonPath('data.title', 'Kit');
    }

    public function test_a_required_component_refuses_null_on_create_and_update(): void
    {
        $refusal = 'identity must be a `object` type, but the final value was: `null`.';
        $this->assertRefused($this->api('POST', 'brand-kits', ['title' => 'Kit', 'identity' => null]), ['identity'], $refusal);
        $this->assertSame(0, BrandKit::query()->count());

        $id = $this->make([]);
        $this->assertRefused($this->api('PUT', "brand-kits/{$id}", ['identity' => null]), ['identity'], $refusal);
        $this->show($id)->assertJsonPath('data.identity.mark', 'M');
    }

    public function test_a_create_must_send_a_required_component_which_an_update_and_a_draft_need_not(): void
    {
        $this->assertRefused($this->api('POST', 'brand-kits', ['title' => 'Bare']), ['identity'], 'identity must be defined.');
        $this->assertSame(0, BrandKit::query()->count());

        $id = $this->make([]);
        $this->api('PUT', "brand-kits/{$id}", ['tagline' => 'Kept'])->assertOk()->assertJsonPath('data.identity.mark', 'M');
        $this->api('POST', 'campaigns?status=draft', ['title' => 'Draft'])->assertCreated();
    }

    public function test_a_draft_takes_null_for_a_required_component_which_a_published_write_refuses(): void
    {
        $id = $this->api('POST', 'campaigns?status=draft', ['identity' => ['mark' => 'M']])->assertCreated()->json('data.documentId');

        $this->api('PUT', "campaigns/{$id}?status=draft", ['identity' => null])->assertOk();
        $this->api('GET', "campaigns/{$id}?status=draft&populate=*")->assertOk()->assertJsonPath('data.identity', null);
        $this->assertRefused(
            $this->api('PUT', "campaigns/{$id}", ['identity' => null]),
            ['identity'],
            'identity must be a `object` type, but the final value was: `null`.',
        );
    }

    public function test_a_to_one_link_and_a_file_are_unlinked_by_null_and_a_missing_key_keeps_them(): void
    {
        $partner = Partner::query()->create(['title' => 'Acme']);
        $logo = $this->logo('logo.png');
        $id = $this->make(['partner' => $partner->getKey(), 'logo' => $logo->getKey()]);
        $this->show($id)->assertJsonPath('data.partner.title', 'Acme')->assertJsonPath('data.logo.id', $logo->getKey());

        $this->api('PUT', "brand-kits/{$id}", ['tagline' => 'Kept'])->assertOk();
        $this->show($id)->assertJsonPath('data.partner.title', 'Acme')->assertJsonPath('data.logo.id', $logo->getKey());

        $this->api('PUT', "brand-kits/{$id}", ['partner' => null, 'logo' => null])->assertOk();
        $this->show($id)->assertJsonPath('data.partner', null)->assertJsonPath('data.logo', null);
        $this->assertSame(1, Partner::query()->count());
        $this->assertSame(1, File::query()->count());
    }

    public function test_a_to_many_link_and_a_set_of_files_are_emptied_by_null(): void
    {
        $partners = [Partner::query()->create(['title' => 'A']), Partner::query()->create(['title' => 'B'])];
        $files = [$this->logo('one.png'), $this->logo('two.png')];
        $id = $this->make(['allies' => array_map(fn ($p) => $p->getKey(), $partners), 'gallery' => array_map(fn ($f) => $f->getKey(), $files)]);
        $this->show($id)->assertJsonCount(2, 'data.allies')->assertJsonCount(2, 'data.gallery');

        $this->api('PUT', "brand-kits/{$id}", ['allies' => null, 'gallery' => null])->assertOk();
        $cleared = $this->show($id);
        $cleared->assertJsonCount(0, 'data.allies');
        // Strapi answers an emptied set of files as null.
        $this->assertEmpty($cleared->json('data.gallery'));
    }

    public function test_a_component_is_cleared_by_null_and_a_field_of_it_by_its_own(): void
    {
        $id = $this->make(['seo' => ['headline' => 'H', 'summary' => 'S']]);

        $this->api('PUT', "brand-kits/{$id}", ['seo' => ['headline' => null, 'summary' => 'S2']])->assertOk();
        $this->show($id)->assertJsonPath('data.seo.headline', null)->assertJsonPath('data.seo.summary', 'S2');

        $this->api('PUT', "brand-kits/{$id}", ['seo' => null])->assertOk();
        $this->show($id)->assertJsonPath('data.seo', null);
        $this->api('PUT', "brand-kits/{$id}", ['seo' => ['headline' => 'Back']])->assertOk();
        $this->show($id)->assertJsonPath('data.seo.headline', 'Back')->assertJsonPath('data.seo.summary', null);
    }

    public function test_a_component_cleared_by_null_takes_the_items_of_a_repeatable_inside_it(): void
    {
        $id = $this->make(['seo' => ['headline' => 'H', 'keywords' => [['label' => 'one'], ['label' => 'two']]]]);
        $this->api('GET', "brand-kits/{$id}?populate[seo][populate]=*")->assertOk()->assertJsonCount(2, 'data.seo.keywords');

        $this->api('PUT', "brand-kits/{$id}", ['seo' => null])->assertOk();
        $this->show($id)->assertJsonPath('data.seo', null);
        // Written again, the component holds none of the items it held before it was cleared.
        $this->api('PUT', "brand-kits/{$id}", ['seo' => ['headline' => 'Back']])->assertOk();
        $this->api('GET', "brand-kits/{$id}?populate[seo][populate]=*")->assertOk()
            ->assertJsonPath('data.seo.headline', 'Back')
            ->assertJsonCount(0, 'data.seo.keywords');
    }

    public function test_a_repeatable_component_and_a_dynamic_zone_refuse_null(): void
    {
        $id = $this->make(['links' => [['label' => 'a']], 'blocks' => [['__component' => 'shared.link', 'label' => 'z']]]);

        foreach (['links', 'blocks'] as $key) {
            $this->assertRefused(
                $this->api('PUT', "brand-kits/{$id}", [$key => null]),
                [$key],
                "{$key} must be a `array` type, but the final value was: `null`.",
            );
        }
        $this->show($id)->assertJsonCount(1, 'data.links')->assertJsonCount(1, 'data.blocks');
    }

    public function test_a_field_the_grant_assigns_cannot_be_cleared_or_changed_by_the_client(): void
    {
        $other = User::factory()->create(['username' => 'other']);
        $made = $this->api('POST', 'profiles', ['displayName' => 'Me', 'bio' => 'Hi', 'owner' => null])->assertCreated()->json('data.documentId');
        $this->assertSame($this->user->getKey(), (int) Profile::query()->where('document_id', $made)->value('owner_id'));

        $this->api('PUT', "profiles/{$made}", ['bio' => null, 'owner' => null])->assertOk()->assertJsonPath('data.bio', null);
        $this->assertSame($this->user->getKey(), (int) Profile::query()->where('document_id', $made)->value('owner_id'));
        $this->api('PUT', "profiles/{$made}", ['owner' => $other->getKey()])->assertOk();
        $this->assertSame($this->user->getKey(), (int) Profile::query()->where('document_id', $made)->value('owner_id'));
    }
}
