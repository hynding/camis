<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Ledger;
use App\Models\User;
use Brick\Math\BigDecimal;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Decimals stating their digits (the decimals fixture, issue #104) on the Strapi API style: a
 * decimal beyond a double keeps every digit over REST and GraphQL, sent and answered as a string,
 * on SQLite, MySQL and PostgreSQL; one within a double keeps Strapi's number. CI's decimals job
 * copies this into the scaffolded app's tests/Feature, once per database.
 */
class DecimalsTest extends TestCase
{
    use RefreshDatabase;

    private const BALANCE = '12345678901.123456';

    private const AMOUNT = '-98765432109.876543';

    private const CEILING = '1234567890123456.78';

    /** Fifteen digits: PHP writes a float with fourteen, so this one is never read through a float. */
    private const SHARE = '1234567890.12345';

    /** Fourteen digits: SQLite's double and PHP's float keep each of them. */
    private const UNITS = '1234567890.1234';

    private string $jwt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'keeper']);
        $user->assignRole('authenticated');
        $this->jwt = $user->createToken('api')->plainTextToken;
    }

    private function api(string $method, string $uri, ?array $data = null): TestResponse
    {
        return $this->withHeader('Authorization', 'Bearer '.$this->jwt)->json($method, '/api/'.$uri, $data === null ? [] : ['data' => $data]);
    }

    private function graphql(string $query): TestResponse
    {
        return $this->withHeader('Authorization', 'Bearer '.$this->jwt)->postJson('/graphql', ['query' => $query])->assertOk()->assertJsonMissingPath('errors');
    }

    public function test_rest_round_trips_every_digit_of_a_decimal_beyond_a_double(): void
    {
        $created = $this->api('POST', 'ledgers?populate=*', [
            'label' => 'main',
            'balance' => self::BALANCE,
            'rate' => 12345.6789,
            'share' => self::SHARE,
            'units' => self::UNITS,
            'fee' => 12.5,
            'limit' => ['ceiling' => self::CEILING],
            'entries' => [['memo' => 'refund', 'amount' => self::AMOUNT]],
        ])->assertCreated();
        $this->assertSame(self::BALANCE, $created->json('data.balance'));

        $read = $this->api('GET', 'ledgers/'.$created->json('data.documentId').'?populate=*')->assertOk();
        $this->assertSame(self::BALANCE, $read->json('data.balance'));
        $this->assertSame(self::CEILING, $read->json('data.limit.ceiling'));
        $this->assertSame(self::AMOUNT, $read->json('data.entries.0.amount'));
        $this->assertSame(self::SHARE, $read->json('data.share'));
        $this->assertSame(self::SHARE, Ledger::query()->sole()->share);
        $this->assertSame((float) self::UNITS, $read->json('data.units'));
        $this->assertSame(self::UNITS, Ledger::query()->sole()->units);
        // Within a double a decimal stays the number Strapi answers.
        $this->assertSame(12345.6789, $read->json('data.rate'));
        $this->assertSame(12.5, $read->json('data.fee'));
        // The row keeps the digits, whatever the database.
        $this->assertSame(self::BALANCE, Ledger::query()->sole()->balance);
        $this->assertTrue(BigDecimal::of(self::BALANCE)->isEqualTo((string) DB::table('ledgers')->value('balance')));

        $updated = $this->api('PUT', 'ledgers/'.$created->json('data.documentId'), ['balance' => '-0.000001'])->assertOk();
        $this->assertSame('-0.000001', $updated->json('data.balance'));
        $this->assertSame(['-0.000001'], array_column($this->api('GET', 'ledgers')->json('data'), 'balance'));
    }

    public function test_a_number_too_long_for_a_double_is_taken_rounded_as_json_reads_it(): void
    {
        // PHP's json_decode, like JavaScript's JSON.parse, reads 12345678901.123456 as a double.
        $created = $this->api('POST', 'ledgers', ['balance' => (float) self::BALANCE])->assertCreated();
        $this->assertSame('12345678901.123455', $created->json('data.balance'));
    }

    public function test_graphql_round_trips_every_digit_of_a_decimal_beyond_a_double(): void
    {
        $created = $this->graphql('mutation { createLedger(data: { label: "gql", balance: "'.self::BALANCE.'", rate: 0.5, entries: [{ memo: "m", amount: "'.self::AMOUNT.'" }] }) { documentId balance rate entries { amount } } }');
        $this->assertSame(self::BALANCE, $created->json('data.createLedger.balance'));
        $this->assertSame(self::AMOUNT, $created->json('data.createLedger.entries.0.amount'));
        $this->assertSame(0.5, $created->json('data.createLedger.rate'));

        $this->graphql('{ ledgers { label balance } }')
            ->assertJsonPath('data.ledgers', [['label' => 'gql', 'balance' => self::BALANCE]]);
    }
}
