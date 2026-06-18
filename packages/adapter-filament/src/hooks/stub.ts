import type { Hook } from "@camis/ir-schema";

// Protected hand-written stub (seed mode, NO generated marker).
export const emitHookStub = (h: Hook): string => `<?php

declare(strict_types=1);

namespace App\\Hooks;

use App\\Hooks\\Contracts\\${h.name}Hook;

// Ring 2 hook — hand-written. camis seeds this once and never overwrites it.
final class ${h.name} implements ${h.name}Hook
{
    public function run(array $input): array
    {
        // TODO: implement the behavior for "${h.name}".
        return $input;
    }
}
`;
