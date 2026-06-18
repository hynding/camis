import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";

export const emitModel = (ct: ContentType): string => {
  const names = filamentNames(ct);
  const emits = ct.fields.map(emitField);
  const fillable = emits.map((e) => `        '${e.column}',`).join("\n");
  const casts = emits
    .filter((e) => e.cast !== undefined)
    .map((e) => `            '${e.column}' => ${e.cast},`)
    .join("\n");
  const castsMethod =
    casts.length > 0
      ? `\n    protected function casts(): array\n    {\n        return [\n${casts}\n        ];\n    }\n`
      : "";
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class ${names.model} extends Model
{
    protected $table = '${names.table}';

    protected $fillable = [
${fillable}
    ];
${castsMethod}}
`;
};
