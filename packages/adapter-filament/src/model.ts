import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";
import type { RelationMethod } from "./relations";

export const emitModel = (ct: ContentType, relations: RelationMethod[] = []): string => {
  const names = filamentNames(ct);
  const emits = ct.fields.filter((f) => f.type !== "relation").map(emitField);
  const fillable = emits.map((e) => `        '${e.column}',`).join("\n");
  const casts = emits
    .filter((e) => e.cast !== undefined)
    .map((e) => `            '${e.column}' => ${e.cast},`)
    .join("\n");
  const castsMethod =
    casts.length > 0
      ? `\n    protected function casts(): array\n    {\n        return [\n${casts}\n        ];\n    }\n`
      : "";
  const relImports = [...new Set(relations.map((r) => r.import))]
    .sort()
    .map((i) => `use ${i};`)
    .join("\n");
  const relUse = relImports ? `${relImports}\n` : "";
  const relMethods = relations.length > 0 ? `\n${relations.map((r) => r.php).join("\n\n")}\n` : "";
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
${relUse}
class ${names.model} extends Model
{
    protected $table = '${names.table}';

    protected $fillable = [
${fillable}
    ];
${castsMethod}${relMethods}}
`;
};
