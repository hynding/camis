import { emitPhp } from "@camis/expr-php-emit";
import type { ContentType } from "@camis/ir-schema";
import { snakeColumn } from "../names";
import type { PolicyMethodSpec, PolicySpec } from "./project";

const userData = [
  "            'user.id' => $user->id,",
  "            'user.email' => $user->email,",
  "            'user.role' => $user->getRoleNames()->first(),",
];

const recordData = (ct: ContentType): string[] =>
  ct.fields
    .filter((f) => f.type !== "relation")
    .map((f) => `            'record.${f.name}' => $record->${snakeColumn(f.name)},`);

const method = (m: PolicyMethodSpec, ct: ContentType): string => {
  const sig = m.record
    ? `    public function ${m.method}(User $user, ${ct.name} $record): bool`
    : `    public function ${m.method}(User $user): bool`;
  if (!m.condition) {
    return `${sig}\n    {\n        return $user->can('${m.key}');\n    }`;
  }
  const data = [...userData, ...(m.record ? recordData(ct) : [])].join("\n");
  return `${sig}
    {
        if (! $user->can('${m.key}')) {
            return false;
        }
        $data = [
${data}
        ];
        $result = ${emitPhp(m.condition)};
        return $result['ok'] === true && $result['value'] === true;
    }`;
};

export const emitPolicy = (spec: PolicySpec, ct: ContentType): string => {
  const hasCondition = spec.methods.some((m) => m.condition !== undefined);
  const ring1Use = hasCondition ? "use App\\Support\\Ring1;\n" : "";
  const body = spec.methods.map((m) => method(m, ct)).join("\n\n");
  return `<?php

declare(strict_types=1);

namespace App\\Policies;

use App\\Models\\${spec.model};
use App\\Models\\User;
${ring1Use}
class ${spec.model}Policy
{
${body}
}
`;
};
