import type { ContentType, Hook } from "@camis/ir-schema";
import { filamentNames, snakeColumn } from "../names";
import { PHP_MARKER } from "./names";

// Generated Eloquent observer: on the publish transition, run the hook and apply its output.
export const emitHookObserver = (h: Hook, ct: ContentType): string => {
  const n = filamentNames(ct);
  const inputArr = h.input.map((f) => `'${f.name}' => $record->${snakeColumn(f.name)}`).join(", ");
  const apply = h.output
    .map((f) => `            $record->${snakeColumn(f.name)} = $out['${f.name}'];`)
    .join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Observers;

use App\\Hooks\\${h.name};
use App\\Models\\${n.model};

class ${n.model}Observer
{
    public function updated(${n.model} $record): void
    {
        if ($record->wasChanged('published_at') && $record->published_at !== null) {
            $out = (new ${h.name}())->run([${inputArr}]);
${apply}
            $record->saveQuietly();
        }
    }
}
`;
};
