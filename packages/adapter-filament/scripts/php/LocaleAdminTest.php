<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Articles\Pages\EditArticle;
use App\Filament\Resources\Articles\Pages\ListArticles;
use App\Models\Article;
use App\Models\Locale;
use App\Models\User;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated Filament admin for a localized type (the strapi-api fixture's Article): it lists
 * the default locale, translates a document into a locale it lacks, and hides translating without
 * the create grant. CI copies this into the scaffolded app's tests/Feature.
 */
class LocaleAdminTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        Locale::create(['code' => 'fr', 'name' => 'French (fr)']);
        $user = User::factory()->create(['username' => 'admin']);
        $user->givePermissionTo($permissions);
        $this->actingAs($user);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    public function test_the_edit_page_translates_into_a_missing_locale(): void
    {
        $this->login(['article.read', 'article.update', 'article.create']);
        $english = Article::create(['title' => 'Hello', 'code' => 'A1', 'locale' => 'en']);
        $french = Article::create(['title' => 'Seul', 'code' => 'B1', 'locale' => 'fr']);
        Livewire::test(ListArticles::class)->assertCanSeeTableRecords([$english])->assertCanNotSeeTableRecords([$french]);

        Livewire::test(EditArticle::class, ['record' => $english->getRouteKey()])
            ->assertActionVisible('translate')
            ->callAction('translate', ['locale' => 'fr'])
            ->assertHasNoActionErrors();
        $copy = Article::where('document_id', $english->document_id)->where('locale', 'fr')->firstOrFail();
        $this->assertSame('A1', $copy->code);
        $this->assertSame(2, Article::where('document_id', $english->document_id)->count());

        // Shared fields stay equal in every locale.
        $copy->update(['code' => 'A2']);
        $this->assertSame('A2', $english->fresh()->code);
    }

    public function test_translating_is_hidden_without_the_create_grant(): void
    {
        $this->login(['article.read', 'article.update']);
        $english = Article::create(['title' => 'Hello', 'code' => 'A1', 'locale' => 'en']);
        Livewire::test(EditArticle::class, ['record' => $english->getRouteKey()])->assertActionHidden('translate');
    }
}
