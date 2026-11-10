<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Menus\Pages\CreateMenu;
use App\Filament\Resources\Menus\Pages\EditMenu;
use App\Http\Serializers\MenuSerializer;
use App\Models\AdminUser;
use App\Models\Author;
use App\Models\Menu;
use App\Models\Topic;
use App\Models\User;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated admin for relations inside components and repeatables inside repeatables (the
 * strapi-api fixture's Menu), beyond what component-vectors.json reaches over REST: the form's
 * pickers and nested repeaters write the rows the API reads, the zone's Builder too, the edit page
 * reads them back, and publishing takes every link and nested item along. CI copies this into the
 * scaffolded app's tests/Feature.
 */
class ComponentRelationsAdminTest extends TestCase
{
    use RefreshDatabase;

    private function login(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = AdminUser::forceCreate(['firstname' => 'Admin', 'email' => 'admin@example.test', 'is_active' => true]);
        $user->givePermissionTo(['menu.create', 'menu.read', 'menu.update', 'menu.publish']);
        $this->actingAs($user, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    /** @return array<string, mixed> */
    private function wire(Menu $menu): array
    {
        return MenuSerializer::toWire($menu->fresh());
    }

    public function test_the_form_writes_component_links_and_nested_items(): void
    {
        $this->login();
        $ann = Author::create(['name' => 'Ann']);
        $news = Topic::create(['name' => 'News']);
        $sport = Topic::create(['name' => 'Sport']);
        Livewire::test(CreateMenu::class)
            ->fillForm([
                'title' => 'Main',
                'cta_label' => 'Start',
                'cta_author_id' => $ann->getKey(),
                'ctaTopics' => [$sport->getKey(), $news->getKey()],
                'sections' => [
                    'b' => ['type' => 'shared.menu-item', 'data' => [
                        'label' => 'Zoned',
                        'linkTopics' => [$sport->getKey()],
                        'children' => ['y' => ['label' => 'Inner', 'author_id' => $ann->getKey(), 'topics' => [$news->getKey(), $sport->getKey()]]],
                    ]],
                ],
            ])
            // Set, not fillForm, which would keep the repeater's default empty item beside it.
            ->set('data.items', ['a' => [
                'label' => 'Home',
                'link_author_id' => $ann->getKey(),
                'children' => ['x' => ['label' => 'First', 'author_id' => $ann->getKey(), 'topics' => [$news->getKey()]]],
            ]])
            ->call('create')
            ->assertHasNoFormErrors();
        $menu = Menu::sole();
        $this->assertSame($ann->getKey(), $menu->ctaAuthor?->getKey());
        $this->assertEqualsCanonicalizing([$news->getKey(), $sport->getKey()], $menu->ctaTopics->modelKeys());
        $item = $menu->items()->sole();
        $this->assertSame($ann->getKey(), $item->linkAuthor?->getKey());
        $child = $item->children()->sole();
        $this->assertSame(['First', $ann->getKey(), [$news->getKey()]], [$child->label, $child->author?->getKey(), $child->topics->modelKeys()]);
        $section = $menu->sectionsMenuItem()->sole();
        $this->assertSame([$sport->getKey()], $section->linkTopics->modelKeys());
        $inner = $section->children()->sole();
        $this->assertSame(['Inner', $ann->getKey()], [$inner->label, $inner->author?->getKey()]);
        $this->assertEqualsCanonicalizing([$news->getKey(), $sport->getKey()], $inner->topics->modelKeys());

        // The edit page reads the zone's links and nested items back, and saving keeps them.
        $page = Livewire::test(EditMenu::class, ['record' => $menu->getRouteKey()]);
        $state = array_values($page->get('data')['sections']);
        $this->assertSame([$sport->getKey()], array_map('intval', $state[0]['data']['linkTopics']));
        $nested = array_values($state[0]['data']['children']);
        $this->assertSame('Inner', $nested[0]['label']);
        $page->call('save')->assertHasNoFormErrors();
        $inner = $menu->fresh()->sectionsMenuItem()->sole()->children()->sole();
        $this->assertSame(['Inner', $ann->getKey()], [$inner->label, $inner->author?->getKey()]);
        $this->assertEqualsCanonicalizing([$news->getKey(), $sport->getKey()], $inner->topics->modelKeys());

        // Publishing copies every item, nested ones too, with their links.
        $page->callAction('publish');
        $published = $this->wire(Menu::whereNotNull('published_at')->sole());
        $draft = $this->wire($menu);
        $strip = fn (mixed $value): mixed => is_array($value) ? array_map(fn ($v) => is_array($v) ? array_diff_key($v, ['id' => true]) : $v, $value) : $value;
        $this->assertSame(array_map('count', [$draft['items'], $draft['sections']]), array_map('count', [$published['items'], $published['sections']]));
        $this->assertSame('First', $published['items'][0]['children'][0]['label'] ?? null);
        $this->assertSame('Inner', $published['sections'][0]['children'][0]['label'] ?? null);
        $this->assertSame($strip($draft['items'][0]['children']), $strip($published['items'][0]['children']));
        $publishedMenu = Menu::whereNotNull('published_at')->sole();
        $this->assertSame($ann->getKey(), $publishedMenu->ctaAuthor?->getKey());
        $this->assertSame(['Inner', $ann->getKey()], [
            $publishedMenu->sectionsMenuItem()->sole()->children()->sole()->label,
            $publishedMenu->sectionsMenuItem()->sole()->children()->sole()->author?->getKey(),
        ]);
    }

    public function test_deleting_a_target_unlinks_it_from_every_component(): void
    {
        $this->login();
        $ann = Author::create(['name' => 'Ann']);
        $news = Topic::create(['name' => 'News']);
        Livewire::test(CreateMenu::class)
            ->fillForm(['title' => 'Main', 'cta_author_id' => $ann->getKey()])
            ->set('data.items', ['a' => ['label' => 'Home', 'children' => ['x' => ['label' => 'First', 'author_id' => $ann->getKey(), 'topics' => [$news->getKey()]]]]])
            ->call('create')
            ->assertHasNoFormErrors();
        $ann->delete();
        $news->delete();
        $menu = Menu::sole();
        $this->assertNull($menu->cta_author_id);
        $child = $menu->items()->sole()->children()->sole();
        $this->assertNull($child->author_id);
        $this->assertSame([], $child->topics->modelKeys());
    }
}
