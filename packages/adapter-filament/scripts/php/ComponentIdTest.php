<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Book;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Strapi sends every component with an id, embedded ones included, keeps it when a populate
 * narrows the component's fields, and takes it back on a write (the strapi-api fixture's Book:
 * price is embedded, editions repeatable). CI copies this into the scaffolded app's tests/Feature.
 */
class ComponentIdTest extends TestCase
{
    use RefreshDatabase;

    private string $jwt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'ann']);
        $user->assignRole('authenticated');
        $this->jwt = $user->createToken('api')->plainTextToken;
    }

    private function api(string $method, string $uri, array $data = []): TestResponse
    {
        $this->app['auth']->forgetGuards();

        return $this->json($method, $uri, $data, ['Authorization' => 'Bearer '.$this->jwt]);
    }

    public function test_an_embedded_component_has_an_id_and_an_unset_one_stays_null(): void
    {
        $made = $this->api('POST', '/api/books', ['data' => [
            'title' => 'Alpha',
            'price' => ['minor' => 100, 'currency' => 'USD'],
            'editions' => [['amount' => 1, 'unit' => 'ea']],
        ]])->assertCreated()->json('data');
        $this->api('POST', '/api/books', ['data' => ['title' => 'Beta']])->assertCreated();

        $books = $this->api('GET', '/api/books?populate=*&sort=title')->assertOk()->json('data');
        $this->assertIsInt($books[0]['price']['id']);
        $this->assertSame(['id', 'minor', 'currency'], array_keys($books[0]['price']));
        $this->assertIsInt($books[0]['editions'][0]['id']);
        $this->assertNull($books[1]['price']);

        // Narrowing a component's fields keeps its id, as Strapi always selects it.
        $narrowed = $this->api('GET', '/api/books/'.$made['documentId'].'?populate[price][fields][0]=currency&populate[editions][fields][0]=unit')
            ->assertOk()->json('data');
        $this->assertSame(['id', 'currency'], array_keys($narrowed['price']));
        $this->assertSame(['id', 'unit'], array_keys($narrowed['editions'][0]));

        // A client sends a component back with its id.
        $price = $books[0]['price'];
        $price['minor'] = 250;
        $this->api('PUT', '/api/books/'.$made['documentId'], ['data' => ['price' => $price]])
            ->assertOk()
            ->assertJsonPath('data.price.minor', '250');
        $this->assertSame(1, Book::where('price_minor', 250)->count());
    }

    public function test_graphql_answers_an_embedded_components_id(): void
    {
        $this->api('POST', '/api/books', ['data' => ['title' => 'Alpha', 'price' => ['minor' => 100, 'currency' => 'USD']]])->assertCreated();
        $this->app['auth']->forgetGuards();
        $answer = $this->postJson('/graphql', ['query' => '{ books { price { id currency } } }'], ['Authorization' => 'Bearer '.$this->jwt])
            ->assertOk()
            ->assertJsonMissingPath('errors')
            ->json('data.books.0.price');
        $this->assertNotNull($answer['id']);
        $this->assertSame('USD', $answer['currency']);
    }
}
