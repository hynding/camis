import type { Hook, ShapeField } from "@camis/ir-schema";
import { PHP_MARKER, PHP_TYPE } from "./names";

const shape = (fields: ShapeField[]): string =>
  `array{${fields.map((f) => `${f.name}: ${PHP_TYPE[f.type]}`).join(", ")}}`;

export const emitHookContract = (h: Hook): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Hooks\\Contracts;

interface ${h.name}Hook
{
    /**
     * @param ${shape(h.input)} $input
     * @return ${shape(h.output)}
     */
    public function run(array $input): array;
}
`;
