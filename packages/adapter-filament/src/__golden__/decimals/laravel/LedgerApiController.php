<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Ledger;
use App\Support\DecimalDigits;
use Illuminate\Foundation\Auth\Access\AuthorizesRequests;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class LedgerApiController extends Controller
{
    use AuthorizesRequests;

    private const FIELDS = ['label', 'balance', 'rate', 'share', 'units', 'fee', 'lines', 'limit_ceiling'];

    /** Decimals stating their digits: each column's precision and scale. */
    private const DECIMALS = ['balance' => [20, 6], 'rate' => [9, 4], 'share' => [15, 5], 'units' => [14, 4], 'limit_ceiling' => [18, 2]];

    public function index(): JsonResponse
    {
        $this->authorize('viewAny', Ledger::class);
        return response()->json(Ledger::query()->paginate(50));
    }

    public function show(Ledger $ledger): JsonResponse
    {
        $this->authorize('view', $ledger);
        return response()->json($ledger);
    }

    public function store(Request $request): JsonResponse
    {
        $this->authorize('create', Ledger::class);
        $payload = self::withDecimals($request->only(self::FIELDS));

        return response()->json(Ledger::create($payload), 201);
    }

    public function update(Request $request, Ledger $ledger): JsonResponse
    {
        $this->authorize('update', $ledger);
        $ledger->update(self::withDecimals($request->only(self::FIELDS)));

        return response()->json($ledger);
    }

    public function destroy(Ledger $ledger): JsonResponse
    {
        $this->authorize('delete', $ledger);
        $ledger->delete();

        return response()->json(null, 204);
    }

    /** The payload with each decimal stating its digits as its column keeps it, from a string or a number. */
    private static function withDecimals(array $payload): array
    {
        foreach (self::DECIMALS as $column => [$precision, $scale]) {
            if (($payload[$column] ?? null) === null) {
                continue;
            }
            $decimal = DecimalDigits::canonical($payload[$column], $precision, $scale);
            if ($decimal === null) {
                throw ValidationException::withMessages([$column => "The {$column} field must be a decimal of at most {$precision} digits, {$scale} of them after the point."]);
            }
            $payload[$column] = $decimal;
        }

        return $payload;
    }
}
