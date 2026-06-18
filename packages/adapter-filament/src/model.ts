import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";
import type { RelationMethod } from "./relations";

export const emitModel = (
  ct: ContentType,
  relations: RelationMethod[] = [],
  observed = false,
): string => {
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
  const observerUse = observed ? `use App\\Observers\\${names.model}Observer;\n` : "";
  const relMethods = relations.length > 0 ? `\n${relations.map((r) => r.php).join("\n\n")}\n` : "";
  // Preserve the original `${relUse}\n` blank-line idiom. observerUse appended alongside relUse
  // so when observed=false both are "", leaving the template identical to before (byte-exact golden).
  // When observed=true, observedAttr appears on its own line with a trailing \n before `class`.
  const observedAttr = observed
    ? `#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy([${names.model}Observer::class])]\n`
    : "";
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
${relUse}${observerUse}
${observedAttr}class ${names.model} extends Model
{
    protected $table = '${names.table}';

    protected $fillable = [
${fillable}
    ];
${castsMethod}${relMethods}}
`;
};
