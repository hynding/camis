import type { ContentType } from "@camis/ir-schema";
import { emitField, type FieldEmit } from "./fields";
import { filamentNames } from "./names";
import type { RelationMethod } from "./relations";

export const emitModel = (
  ct: ContentType,
  relations: RelationMethod[] = [],
  observed = false,
  extraEmits: FieldEmit[] = [],
  fkNames: string[] = [],
  extraMethods: string[] = [],
  traits: string[] = [],
  /** Further methods that need no imports of their own. */
  members: string[] = [],
): string => {
  const names = filamentNames(ct);
  const emits = [
    ...ct.fields
      .filter((f) => f.type !== "relation" && f.type !== "component")
      .map((f) => emitField(f)),
    ...extraEmits,
  ];
  const fillable = [...emits.map((e) => e.column), ...fkNames]
    .map((c) => `        '${c}',`)
    .join("\n");
  const casts = emits
    .filter((e) => e.cast !== undefined)
    .map((e) => `            '${e.column}' => ${e.cast},`)
    .join("\n");
  const castsMethod =
    casts.length > 0
      ? `\n    protected function casts(): array\n    {\n        return [\n${casts}\n        ];\n    }\n`
      : "";
  const extraImports =
    extraMethods.length > 0 ? ["App\\Models\\User", "Illuminate\\Database\\Eloquent\\Builder"] : [];
  const relImports = [...new Set([...relations.map((r) => r.import), ...extraImports, ...traits])]
    .sort()
    .map((i) => `use ${i};`)
    .join("\n");
  const relUse = relImports ? `${relImports}\n` : "";
  const observerUse = observed ? `use App\\Observers\\${names.model}Observer;\n` : "";
  const methods = [...relations.map((r) => r.php), ...extraMethods, ...members];
  const relMethods = methods.length > 0 ? `\n${methods.join("\n\n")}\n` : "";
  // Preserve the original `${relUse}\n` blank-line idiom. observerUse appended alongside relUse
  // so when observed=false both are "", leaving the template identical to before (byte-exact golden).
  // When observed=true, observedAttr appears on its own line with a trailing \n before `class`.
  const observedAttr = observed
    ? `#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy([${names.model}Observer::class])]\n`
    : "";
  const traitUse = traits.map((t) => `    use ${t.slice(t.lastIndexOf("\\") + 1)};\n\n`).join("");
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
${relUse}${observerUse}
${observedAttr}class ${names.model} extends Model
{
${traitUse}    protected $table = '${names.table}';

    protected $fillable = [
${fillable}
    ];
${castsMethod}${relMethods}}
`;
};
