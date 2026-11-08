import type { Hook, ShapeField } from "@camis/ir-schema";
import { PHP_MARKER, PHP_TYPE, TRIGGER_DOC } from "./names";

const shape = (fields: ShapeField[]): string =>
  `array{${fields.map((f) => `${f.name}: ${PHP_TYPE[f.type]}`).join(", ")}}`;

export const emitHookContract = (h: Hook): string => {
  const returns = h.output.length > 0;
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Hooks\\Contracts;

interface ${h.name}Hook
{
    /**
     * ${TRIGGER_DOC[h.trigger]}
     *
     * @param ${shape(h.input)} $input${returns ? `\n     * @return ${shape(h.output)}` : ""}
     */
    public function run(array $input): ${returns ? "array" : "void"};
}
`;
};
