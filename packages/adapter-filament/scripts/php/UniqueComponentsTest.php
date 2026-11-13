<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Unique fields inside components and dynamic zones (the unique-components fixture), answered as
 * strapi-php answers them: every depth is checked against the other entries, while two items of one
 * request clash only in a top-level repeatable or a dynamic zone. CI's unique-components job copies
 * this into the scaffolded app's tests/Feature.
 */
class UniqueComponentsTest extends TestCase
{
    use RefreshDatabase;

    private string $jwt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'planner']);
        $user->assignRole('authenticated');
        $this->jwt = $user->createToken('api')->plainTextToken;
    }

    /** @param array<string, mixed> $data */
    private function create(array $data): TestResponse
    {
        return $this->withHeader('Authorization', 'Bearer '.$this->jwt)->postJson('/api/events', ['data' => $data]);
    }

    /** @param list<array{0: list<string>, 1: string}> $clashes path and value of each */
    private function assertNotUnique(TestResponse $response, array $clashes): void
    {
        $response->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')
            ->assertJsonPath('error.message', count($clashes) === 1 ? 'This attribute must be unique' : count($clashes).' errors occurred')
            ->assertJsonPath('error.details.errors', array_map(fn (array $clash) => [
                'path' => $clash[0],
                'message' => 'This attribute must be unique',
                'name' => 'ValidationError',
                'value' => $clash[1],
            ], $clashes));
    }

    public function test_a_value_another_entry_holds_is_refused_at_every_depth(): void
    {
        $this->create([
            'title' => 'one',
            'badge' => ['code' => 'B1'],
            'slots' => [['label' => 's', 'badge' => ['code' => 'S1'], 'seats' => [['code' => 'T1']]]],
            'info' => ['passes' => [['code' => 'P1']]],
            'blocks' => [['__component' => 'shared.badge', 'code' => 'Z1']],
        ])->assertCreated();

        $this->assertNotUnique($this->create(['title' => 'a', 'badge' => ['code' => 'B1']]), [[['badge', 'code'], 'B1']]);
        $this->assertNotUnique(
            $this->create(['title' => 'b', 'slots' => [['label' => 'x', 'badge' => ['code' => 'S1']]]]),
            [[['slots', '0', 'badge', 'code'], 'S1']],
        );
        $this->assertNotUnique(
            $this->create(['title' => 'c', 'slots' => [['label' => 'x', 'seats' => [['code' => 'T1']]]]]),
            [[['slots', '0', 'seats', '0', 'code'], 'T1']],
        );
        $this->assertNotUnique(
            $this->create(['title' => 'd', 'info' => ['passes' => [['code' => 'P1']]]]),
            [[['info', 'passes', '0', 'code'], 'P1']],
        );
        $this->assertNotUnique(
            $this->create(['title' => 'e', 'blocks' => [['__component' => 'shared.badge', 'code' => 'Z1']]]),
            [[['blocks', '0', 'code'], 'Z1']],
        );
    }

    public function test_two_items_of_one_request_clash_only_in_a_top_level_repeatable_or_a_zone(): void
    {
        $this->assertNotUnique(
            $this->create(['title' => 'f', 'slots' => [['label' => 'x', 'badge' => ['code' => 'N1']], ['label' => 'y', 'badge' => ['code' => 'N1']]]]),
            [[['slots', '0', 'badge', 'code'], 'N1'], [['slots', '1', 'badge', 'code'], 'N1']],
        );
        $this->assertNotUnique(
            $this->create(['title' => 'g', 'blocks' => [['__component' => 'shared.badge', 'code' => 'N2'], ['__component' => 'shared.badge', 'code' => 'N2']]]),
            [[['blocks', '0', 'code'], 'N2'], [['blocks', '1', 'code'], 'N2']],
        );
        // A repeatable inside another component is not compared with itself.
        $this->create(['title' => 'h', 'slots' => [['label' => 'x', 'seats' => [['code' => 'N3'], ['code' => 'N3']]]]])->assertCreated();
        $this->create(['title' => 'i', 'info' => ['passes' => [['code' => 'N4'], ['code' => 'N4']]]])->assertCreated();
    }

    public function test_an_entry_keeps_its_own_values_and_empty_ones_never_clash(): void
    {
        $id = $this->create(['title' => 'h', 'badge' => ['code' => 'K1'], 'slots' => [['label' => 'x', 'seats' => [['code' => 'N3']]]]])
            ->assertCreated()->json('data.documentId');

        $this->withHeader('Authorization', 'Bearer '.$this->jwt)
            ->putJson('/api/events/'.$id, ['data' => ['title' => 'h2', 'slots' => [['label' => 'x', 'seats' => [['code' => 'N3']]]]]])
            ->assertOk();
        $this->create(['title' => 'n', 'badge' => ['code' => ''], 'slots' => [['label' => 'z', 'badge' => ['code' => null]]]])->assertCreated();
        $this->create(['title' => 'o', 'badge' => ['code' => '']])->assertCreated();
    }
}
