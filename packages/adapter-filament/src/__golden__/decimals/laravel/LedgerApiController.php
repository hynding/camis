<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Ledger;
use Illuminate\Foundation\Auth\Access\AuthorizesRequests;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class LedgerApiController extends Controller
{
    use AuthorizesRequests;

    private const FIELDS = ['label', 'balance', 'rate', 'share', 'units', 'fee', 'limit_ceiling'];

    /** Decimals stating their digits. */
    private const DECIMALS = ['balance', 'rate', 'share', 'units', 'limit_ceiling'];

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

    /** The payload with each decimal's JSON number as its shortest digits. */
    private static function withDecimals(array $payload): array
    {
        foreach (self::DECIMALS as $column) {
            if (is_float($payload[$column] ?? null)) {
                $payload[$column] = var_export($payload[$column], true);
            }
        }

        return $payload;
    }
}
