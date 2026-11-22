<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Ledgers\Pages\CreateLedger;
use App\Filament\Resources\Ledgers\Pages\EditLedger;
use App\Models\AdminUser;
use App\Models\Ledger;
use App\Models\User;
use App\Support\DecimalDigits;
use Brick\Math\BigDecimal;
use Filament\Facades\Filament;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Illuminate\Validation\ValidationException;
use Livewire\Livewire;
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

    public function test_filters_compare_a_value_with_more_digits_than_the_scale_exactly_never_rounding_it(): void
    {
        foreach (['r0' => ['1.0000', '1.000000'], 'r1' => ['1.0001', '1.000001'], 'r2' => ['1.0002', '1.000002']] as $label => [$rate, $balance]) {
            $this->api('POST', 'ledgers', ['label' => $label, 'rate' => $rate, 'balance' => $balance])->assertCreated();
        }
        // A row without a value, which no comparison but $null finds, on any database.
        $this->api('POST', 'ledgers', ['label' => 'empty'])->assertCreated();
        $all = ['r0', 'r1', 'r2'];

        foreach ([
            'filters[rate][$gt]=1.00005' => ['r1', 'r2'],
            'filters[rate][$gte]=1.00004' => ['r1', 'r2'],
            'filters[rate][$lt]=1.00015' => ['r0', 'r1'],
            'filters[rate][$lte]=1.00005' => ['r0'],
            'filters[rate][$eq]=1.00004' => [],
            'filters[rate]=1.00004' => [],
            'filters[rate][$eq]=1.0001000' => ['r1'],
            'filters[rate][$ne]=1.00004' => $all,
            'filters[rate][$in][0]=1.00004&filters[rate][$in][1]=1.0001' => ['r1'],
            'filters[rate][$in][0]=1.00004' => [],
            'filters[rate][0]=1.00004&filters[rate][1]=1.0002' => ['r2'],
            'filters[rate][$notIn][0]=1.00004' => $all,
            'filters[rate][$notIn][0]=1.00004&filters[rate][$notIn][1]=1.0001' => ['r0', 'r2'],
            'filters[rate][$between][0]=1.00005&filters[rate][$between][1]=1.00015' => ['r1'],
            // Beyond every value (9, 4) holds.
            'filters[rate][$lt]=1e10' => $all,
            'filters[rate][$gt]=-1e10' => $all,
            'filters[rate][$gt]=1e10' => [],
            'filters[rate][$eq]=1e10' => [],
            'filters[rate][$ne]=1e10' => $all,
            'filters[rate][$lte]=99999.99995' => $all,
            'filters[rate][$gte]=99999.99995' => [],
            'filters[rate][$not][$gt]=1.00005' => ['r0'],
            // Decided without comparing a value, a filter still finds no row without one under $not.
            'filters[rate][$not][$eq]=1.00005' => $all,
            'filters[rate][$not][$ne]=1.00005' => [],
            'filters[rate][$not][$in][0]=1.00005' => $all,
            'filters[rate][$not][$notIn][0]=1.00005' => [],
            'filters[rate][$not][$eq]=1e10' => $all,
            'filters[rate][$not][$ne]=1e10' => [],
            'filters[rate][$not][$gt]=1e10' => $all,
            'filters[rate][$not][$lt]=1e10' => [],
            'filters[rate][$not][$gte]=-1e10' => [],
            'filters[rate][$not][$lte]=-1e10' => $all,
            'filters[$not][rate][$eq]=1.00005' => $all,
            'filters[$not][balance][$ne]=1e30' => [],
            'filters[balance][$gt]=1.0000005' => ['r1', 'r2'],
            'filters[balance][$gte]=1.0000004' => ['r1', 'r2'],
            'filters[balance][$lte]=1.0000015' => ['r0', 'r1'],
            'filters[balance][$eq]=1.0000004' => [],
            'filters[balance][$ne]=1.0000004' => $all,
            'filters[balance][$eq]=1.000001' => ['r1'],
            'filters[balance][$eq]=1e-999' => [],
            // A list's unreadable item equals none of its values; the others still compare exactly.
            'filters[balance][$in][0]=abc&filters[balance][$in][1]=1.0000010' => ['r1'],
            'filters[balance][$notIn][0]=abc&filters[balance][$notIn][1]=1.0000010' => ['r0', 'r2'],
            // $between takes its first two values as its bounds.
            'filters[balance][$between][0]=1e0&filters[balance][$between][1]=1.000001e0&filters[balance][$between][2]=7' => ['r0', 'r1'],
        ] as $query => $expected) {
            $this->assertSame($expected, $this->labels($query), $query);
        }

        $labels = fn (string $filter): array => array_map(fn (array $l) => $l['label'], $this->graphql('{ ledgers(sort: "label", filters: '.$filter.') { label } }')->json('data.ledgers'));
        $this->assertSame(['r1', 'r2'], $labels('{ rate: { gt: 1.00005 } }'));
        $this->assertSame(['r0'], $labels('{ rate: { lte: 1.00005 } }'));
        $this->assertSame([], $labels('{ rate: { eq: 1.00004 } }'));
        $this->assertSame(['r1', 'r2'], $labels('{ balance: { gt: "1.0000005" } }'));
        $this->assertSame([], $labels('{ balance: { in: ["1.0000004"] } }'));
        $this->assertSame($all, $labels('{ not: { rate: { eq: 1.00005 } } }'));
        $this->assertSame([], $labels('{ not: { balance: { notIn: ["1e30"] } } }'));
    }

    public function test_a_value_too_long_or_with_too_large_an_exponent_is_not_a_decimal(): void
    {
        // brick/math writes out every zero an exponent stands for: these are refused before it reads them.
        foreach (['1e100000000', '1e999999999', str_repeat('9', 5000), '1e-999999999', '1e1000', "1\n2", '１２', '0x1A', '1_000'] as $value) {
            $this->assertNull(DecimalDigits::canonical($value, 20, 6), substr($value, 0, 20));
        }
        $this->assertSame('1000.000000', DecimalDigits::canonical('1e3', 20, 6));
        $this->assertSame('0.000000', DecimalDigits::canonical('1e-999', 20, 6));

        // A filter by one is bound as it came, as every number field's unreadable value is.
        foreach (['1e100000000', '1e-999999999', str_repeat('9', 5000)] as $value) {
            $status = $this->api('GET', 'ledgers?filters[balance][$eq]='.$value)->getStatusCode();
            $this->assertContains($status, [200, 400], substr($value, 0, 20));
        }
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

    public function test_a_refused_decimal_in_a_repeatable_or_a_zone_is_named_by_its_full_path(): void
    {
        $tooLong = '123456789012345678901';
        $this->api('POST', 'ledgers', ['label' => 'entries', 'entries' => [['memo' => 'a', 'amount' => '1'], ['memo' => 'b', 'amount' => $tooLong]]])
            ->assertStatus(400)
            ->assertJsonPath('error.message', 'entries[1].amount must be a decimal of at most 20 digits, 6 of them after the point')
            ->assertJsonPath('error.details.errors.0.path', ['entries', '1', 'amount']);
        $this->api('POST', 'ledgers', ['label' => 'lines', 'lines' => [['__component' => 'shared.limit', 'ceiling' => '1'], ['__component' => 'shared.limit', 'ceiling' => $tooLong]]])
            ->assertStatus(400)
            ->assertJsonPath('error.message', 'lines[1].ceiling must be a decimal of at most 18 digits, 2 of them after the point')
            ->assertJsonPath('error.details.errors.0.path', ['lines', '1', 'ceiling']);
        $this->api('POST', 'ledgers', ['label' => 'limit', 'limit' => ['ceiling' => $tooLong]])
            ->assertStatus(400)
            ->assertJsonPath('error.details.errors.0.path', ['limit', 'ceiling']);
        $this->assertFalse(DB::table('ledgers')->exists());

        // A zone's items that fit are kept at their scale, in their order.
        $created = $this->api('POST', 'ledgers?populate=*', ['label' => 'kept', 'lines' => [['__component' => 'shared.limit', 'ceiling' => self::CEILING], ['__component' => 'shared.limit', 'ceiling' => '1.5']]])->assertCreated();
        $this->assertSame([self::CEILING, '1.50'], array_column($created->json('data.lines'), 'ceiling'));
    }

    public function test_every_write_through_eloquent_keeps_a_decimal_as_its_column_keeps_it(): void
    {
        // Past the request's trimming middleware: the model's cast trims, reads and rounds itself.
        $this->assertSame('12.000000', Ledger::query()->create(['label' => 'model', 'balance' => ' 12 '])->balance);
        $this->assertSame('12.000000', (string) DB::table('ledgers')->where('label', 'model')->value('balance'));
        $this->assertSame('1.123457', Ledger::query()->create(['label' => 'rounded', 'balance' => 1.1234565])->balance);
        $this->assertNull(Ledger::query()->create(['label' => 'empty', 'balance' => null])->balance);
        foreach (['INF', '12 x', '1e400', '123456789012345678901'] as $refused) {
            try {
                Ledger::query()->create(['label' => 'refused', 'balance' => $refused]);
                $this->fail("{$refused} was written");
            } catch (ValidationException $e) {
                $this->assertSame([DecimalDigits::refusal('balance', 20, 6)], $e->errors()['balance']);
            }
        }
        $this->assertFalse(DB::table('ledgers')->where('label', 'refused')->exists());

        if (DB::connection()->getDriverName() === 'sqlite') {
            // A value an earlier writer left on SQLite's text column is answered as it is, not a 500.
            DB::table('ledgers')->where('label', 'model')->update(['balance' => '12 x']);
            $this->assertSame('12 x', Ledger::query()->where('label', 'model')->sole()->balance);
        }
        $this->api('GET', 'ledgers?pagination[pageSize]=100')->assertOk()->assertJsonCount(3, 'data');
    }

    private function actingAsAdmin(): void
    {
        $admin = AdminUser::query()->forceCreate(['firstname' => 'Admin', 'email' => 'admin@example.test', 'is_active' => true]);
        $admin->givePermissionTo(['ledger.create', 'ledger.read', 'ledger.update']);
        $this->actingAs($admin, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    public function test_the_admin_form_keeps_every_digit_and_refuses_a_value_that_does_not_fit(): void
    {
        $this->actingAsAdmin();

        Livewire::test(CreateLedger::class)
            ->fillForm(['label' => 'admin', 'balance' => self::BALANCE, 'share' => self::SHARE, 'rate' => '1.50', 'units' => '', 'limit_ceiling' => self::CEILING])
            ->call('create')
            ->assertHasNoFormErrors();
        $row = DB::table('ledgers')->where('label', 'admin')->sole();
        $this->assertSame([self::BALANCE, self::SHARE, null, self::CEILING], [(string) $row->balance, (string) $row->share, $row->units, (string) $row->limit_ceiling]);
        // Within a PHP float SQLite's column is numeric, which keeps 1.5 as a double.
        $this->assertSame('1.5000', Ledger::query()->where('label', 'admin')->sole()->rate);

        foreach (['exponent beyond a double' => '1e400', 'not a decimal' => '12 x', 'too many digits' => '123456789012345678901'] as $label => $balance) {
            Livewire::test(CreateLedger::class)
                ->fillForm(['label' => $label, 'balance' => $balance])
                ->call('create')
                ->assertHasFormErrors(['balance']);
            $this->assertFalse(DB::table('ledgers')->where('label', $label)->exists(), $label);
        }

        app('auth')->forgetGuards();
        $this->api('GET', 'ledgers?pagination[pageSize]=100')->assertOk()->assertJsonPath('data.0.balance', self::BALANCE);
    }

    public function test_the_admin_form_checks_a_unique_decimal_by_its_digits_not_its_text(): void
    {
        $this->actingAsAdmin();
        $held = Ledger::query()->create(['label' => 'held', 'share' => '1.5']);

        // 1.500004 and 1.499995 are stored rounded to the scale, as 1.50000.
        foreach (['1.5', '1.50000', '1.500000000', '15e-1', ' 1.5', '1.500004', '1.499995'] as $share) {
            try {
                $test = Livewire::test(CreateLedger::class)->fillForm(['label' => 'copy', 'share' => $share])->call('create');
            } catch (UniqueConstraintViolationException $e) {
                $this->fail("{$share} passed the form and reached the unique index");
            }
            $this->assertSame(['The share has already been taken.'], $test->errors()->get('data.share'), $share);
        }
        $this->assertSame(['held'], DB::table('ledgers')->pluck('label')->all());

        Livewire::test(CreateLedger::class)->fillForm(['label' => 'other', 'share' => '1.50001'])->call('create')->assertHasNoFormErrors();
        Livewire::test(CreateLedger::class)->fillForm(['label' => 'none', 'share' => ''])->call('create')->assertHasNoFormErrors();
        // Another record edited to the held value as stored.
        $other = Ledger::query()->where('label', 'other')->sole();
        try {
            $test = Livewire::test(EditLedger::class, ['record' => $other->getRouteKey()])->fillForm(['share' => '1.500004'])->call('save');
        } catch (UniqueConstraintViolationException $e) {
            $this->fail('1.500004 passed the edit form and reached the unique index');
        }
        $this->assertSame(['The share has already been taken.'], $test->errors()->get('data.share'));
        // The record being edited keeps its own value.
        Livewire::test(EditLedger::class, ['record' => $held->getRouteKey()])
            ->fillForm(['share' => '1.50'])
            ->call('save')
            ->assertHasNoFormErrors();
        $this->assertSame('1.50000', (string) DB::table('ledgers')->where('label', 'held')->value('share'));
    }

    public function test_the_api_checks_a_unique_decimal_by_its_digits_as_it_is_stored(): void
    {
        $held = $this->api('POST', 'ledgers', ['label' => 'held', 'share' => '1.5'])->assertCreated();
        $other = $this->api('POST', 'ledgers', ['label' => 'other', 'share' => '2'])->assertCreated();

        // Each is stored as 1.50000, so Strapi's unique check refuses it before the unique index does.
        foreach (['1.5', '1.50', '1.500000000', '15e-1', ' 1.5', '1.500004', '1.499995', 1.5] as $share) {
            foreach ([['POST', 'ledgers'], ['PUT', 'ledgers/'.$other->json('data.documentId')]] as [$method, $uri]) {
                $this->api($method, $uri, ['label' => 'copy', 'share' => $share])
                    ->assertStatus(400)
                    ->assertJsonPath('error.message', 'This attribute must be unique')
                    ->assertJsonPath('error.details.errors.0.path', ['share']);
            }
        }
        $this->assertSame(['held', 'other'], DB::table('ledgers')->orderBy('id')->pluck('label')->all());
        $this->assertSame('2.00000', (string) DB::table('ledgers')->where('label', 'other')->value('share'));

        $this->api('POST', 'ledgers', ['label' => 'near', 'share' => '1.50001'])->assertCreated();
        // The entry being updated keeps its own value.
        $this->api('PUT', 'ledgers/'.$held->json('data.documentId'), ['share' => '1.50'])->assertOk();
        $this->assertSame('1.50000', (string) DB::table('ledgers')->where('label', 'held')->value('share'));
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
