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

    /** @return list<string> the labels of the ledgers a list request answers, in label order */
    private function labels(string $query): array
    {
        $labels = array_column($this->api('GET', 'ledgers?'.$query.'&fields[0]=label&pagination[pageSize]=100')->assertOk()->json('data'), 'label');
        sort($labels);

        return $labels;
    }

    public function test_filters_compare_a_decimal_stating_its_digits_at_its_scale_never_through_a_float(): void
    {
        $rows = ['exact' => self::BALANCE, 'neighbour' => '12345678901.123455', 'nine' => '9.5', 'ten' => '10.25', 'negative' => '-3', 'hundred' => '100'];
        foreach ($rows as $label => $balance) {
            $this->api('POST', 'ledgers', ['label' => $label, 'balance' => $balance, 'rate' => $balance === self::BALANCE ? '12345.6789' : '1', 'share' => $balance === self::BALANCE ? self::SHARE : null])->assertCreated();
        }
        $others = array_values(array_diff(array_keys($rows), ['exact']));
        sort($others);

        $this->assertSame(['exact'], $this->labels('filters[balance][$eq]='.self::BALANCE));
        $this->assertSame(['exact'], $this->labels('filters[balance][$eq]=12345678901.1234560'));
        $this->assertSame(['exact'], $this->labels('filters[balance]='.self::BALANCE));
        $this->assertSame($others, $this->labels('filters[balance][$ne]='.self::BALANCE));
        $this->assertSame(['exact', 'nine'], $this->labels('filters[balance][$in][0]='.self::BALANCE.'&filters[balance][$in][1]=9.50'));
        $this->assertSame(['hundred', 'negative', 'neighbour', 'ten'], $this->labels('filters[balance][$notIn][0]='.self::BALANCE.'&filters[balance][$notIn][1]=9.5'));
        $this->assertSame(['exact'], $this->labels('filters[share][$eq]='.self::SHARE));
        // Within a PHP float the column is numeric on every database, so ordering is numeric.
        $this->assertSame(['exact'], $this->labels('filters[rate][$eq]=12345.6789'));
        $this->assertSame(['exact'], $this->labels('filters[rate][$gt]=1'));
        $this->assertSame([], $this->labels('filters[rate][$lt]=1'));
        if (DB::connection()->getDriverName() === 'sqlite') {
            // Beyond a PHP float SQLite keeps text, which an ordering comparison compares as text (the gap says so).
            $this->assertSame(['nine'], $this->labels('filters[balance][$gt]=9'));
        } else {
            $this->assertSame(['exact', 'hundred', 'neighbour', 'nine', 'ten'], $this->labels('filters[balance][$gt]=9'));
            $this->assertSame(['negative', 'nine'], $this->labels('filters[balance][$lte]=9.5'));
            $this->assertSame(['exact'], $this->labels('filters[balance][$gte]='.self::BALANCE));
            $this->assertSame(['hundred', 'negative', 'neighbour', 'nine', 'ten'], $this->labels('filters[balance][$lt]='.self::BALANCE));
            $this->assertSame(['neighbour', 'exact'], array_column($this->api('GET', 'ledgers?sort=balance:asc&filters[balance][$between][0]=12345678901.123455&filters[balance][$between][1]='.self::BALANCE.'&fields[0]=label')->json('data'), 'label'));
        }

        $this->graphql('{ ledgers(filters: { balance: { eq: "'.self::BALANCE.'" } }) { label } }')
            ->assertJsonPath('data.ledgers', [['label' => 'exact']]);
        $this->graphql('{ ledgers(filters: { balance: { ne: "'.self::BALANCE.'" } }) { label } }')
            ->assertJsonCount(5, 'data.ledgers');
        $in = array_column($this->graphql('{ ledgers(filters: { balance: { in: ["'.self::BALANCE.'", "100"] } }) { label } }')->json('data.ledgers'), 'label');
        sort($in);
        $this->assertSame(['exact', 'hundred'], $in);
        $this->graphql('{ ledgers(filters: { balance: { notIn: ["'.self::BALANCE.'", "100"] } }) { label } }')
            ->assertJsonCount(4, 'data.ledgers');
    }

    public function test_a_decimal_stating_its_digits_is_written_at_its_scale_on_every_database(): void
    {
        $taken = [
            'leading space' => [' 12', '12.000000'],
            'trailing space' => ['12 ', '12.000000'],
            'exponent' => ['1e5', '100000.000000'],
            'plus' => ['+5', '5.000000'],
            'leading zeros' => ['007', '7.000000'],
            'negative zero' => ['-0', '0.000000'],
            'half up' => ['1.1234565', '1.123457'],
            'half up negative' => ['-1.0000005', '-1.000001'],
            'one and a half' => ['1.5', '1.500000'],
            'one and fifty hundredths' => ['1.50', '1.500000'],
            'small number' => [1e-7, '0.000000'],
            'tenth' => [0.1, '0.100000'],
            'whole number' => [42, '42.000000'],
        ];
        foreach ($taken as $label => [$sent, $kept]) {
            $created = $this->api('POST', 'ledgers', ['label' => $label, 'balance' => $sent])->assertCreated();
            $this->assertSame($kept, $created->json('data.balance'), $label);
            // The row holds the same digits on every database, so a unique index sees 1.5 and 1.50 as one.
            $this->assertSame($kept, (string) DB::table('ledgers')->where('label', $label)->value('balance'), $label);
        }

        $refused = [
            'too many digits' => '123456789012345678901',
            'rounded beyond the digits' => '99999999999999.9999995',
            'inner space' => ' 12 3 ',
            'too large a number' => 1e21,
        ];
        foreach ($refused as $label => $sent) {
            $this->api('POST', 'ledgers', ['label' => $label, 'balance' => $sent])
                ->assertStatus(400)
                ->assertJsonPath('error.name', 'ValidationError')
                ->assertJsonPath('error.details.errors.0.path', ['balance']);
            $this->assertFalse(DB::table('ledgers')->where('label', $label)->exists(), $label);
        }
        $this->api('POST', 'ledgers', ['entries' => [['memo' => 'm', 'amount' => '123456789012345678901']]])->assertStatus(400);
        $this->api('POST', 'ledgers', ['share' => '12345678901.12345'])->assertStatus(400);

        $this->api('GET', 'ledgers?pagination[pageSize]=100')->assertOk()->assertJsonCount(count($taken), 'data');
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
