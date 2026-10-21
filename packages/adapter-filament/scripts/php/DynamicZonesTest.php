<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Landings\Pages\CreateLanding;
use App\Filament\Resources\Landings\Pages\EditLanding;
use App\Http\Serializers\LandingSerializer;
use App\Models\Landing;
use App\Models\User;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated admin's Builder for a dynamic zone (the strapi-api fixture's Landing blocks),
 * beyond what dynamic-zone-vectors.json reaches over REST: it writes the rows the API reads, in
 * its order, reads them back, and publishing takes them along. CI copies this into the scaffolded
 * app's tests/Feature.
 */
class DynamicZonesTest extends TestCase
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

    /** @return list<string> */
    private function components(Landing $landing): array
    {
        return array_column(LandingSerializer::toWire($landing->fresh())['blocks'], '__component');
    }

    public function test_the_builder_writes_the_zone_the_api_reads(): void
    {
        $this->login(['landing.create', 'landing.read', 'landing.update', 'landing.publish']);
        Livewire::test(CreateLanding::class)
            ->fillForm(['title' => 'Home', 'blocks' => [
                'a' => ['type' => 'shared.quantity', 'data' => ['amount' => 2, 'unit' => 'kg']],
                'b' => ['type' => 'shared.hero', 'data' => ['heading' => 'Hi', 'price_minor' => 5, 'price_currency' => 'EUR']],
            ]])
            ->call('create')
            ->assertHasNoFormErrors();
        $landing = Landing::sole();
        $this->assertSame(['shared.quantity', 'shared.hero'], $this->components($landing));
        $this->assertEquals(['currency' => 'EUR', 'minor' => '5'], LandingSerializer::toWire($landing->fresh())['blocks'][1]['price']);

        $page = Livewire::test(EditLanding::class, ['record' => $landing->getRouteKey()]);
        $state = array_values($page->get('data')['blocks']);
        $this->assertSame(['shared.quantity', 'shared.hero'], array_column($state, 'type'));
        $this->assertSame('Hi', $state[1]['data']['heading']);

        // Set, not fillForm, which would merge the reordered items into the hydrated ones.
        $page->set('data.blocks', ['x' => $state[1], 'y' => $state[0]])->call('save')->assertHasNoFormErrors();
        $this->assertSame(['shared.hero', 'shared.quantity'], $this->components($landing));

        $page->callAction('publish');
        $published = Landing::whereNotNull('published_at')->sole();
        $this->assertSame(['shared.hero', 'shared.quantity'], $this->components($published));
    }

    public function test_the_api_refuses_a_zone_to_a_caller_without_the_grant(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $this->postJson('/api/landings', ['data' => ['title' => 'Home', 'blocks' => [['__component' => 'shared.hero', 'heading' => 'Hi']]]])
            ->assertForbidden();
        $this->assertSame(0, Landing::count());
    }
}
