import type { GeneratedFile } from "@camis/adapter-kernel";
import { aiPlaceholders, type ContentType, type Field, type IrDocument } from "@camis/ir-schema";
import { PHP_MARKER } from "./hooks/names";
import { filamentNames, snakeColumn } from "./names";

type AiField = Field & { ai?: { model?: string; prompt: string; trigger: string } };
const aiOf = (f: Field): AiField["ai"] | undefined => (f as AiField).ai;

export const aiFieldContentTypes = (doc: IrDocument): ContentType[] =>
  doc.contentTypes.filter((ct) => ct.fields.some((f) => aiOf(f) !== undefined));

export const hasAiField = (doc: IrDocument): boolean => aiFieldContentTypes(doc).length > 0;

// Wrap an author-controlled string as a single-quoted PHP literal (escape \\ and ').
const phpSingleQuoted = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// Protected PHP provider seam: deterministic + offline by default (no network / API key in dev/CI).
const PROVIDER = `<?php

declare(strict_types=1);

namespace App\\Ai;

final class Provider
{
    // camis AI provider — REPLACE FOR PRODUCTION.
    // Real impl: read env('ANTHROPIC_API_KEY') and call the model SDK here.
    public static function generate(?string $model, string $prompt): string
    {
        return '[ai:' . ($model ?? 'default') . '] ' . substr($prompt, 0, 80);
    }
}
`;

export const aiProviderFile = (): GeneratedFile => ({
  path: "app/Ai/Provider.php",
  content: PROVIDER,
  mode: "seed",
});

const fireCondition = (trigger: string, dirtyExpr: string): string => {
  if (trigger === "onCreate") return "$isCreate";
  if (trigger === "onUpdate") return `!$isCreate && (${dirtyExpr})`;
  return `$isCreate || (${dirtyExpr})`;
};

export const emitAiObserver = (ct: ContentType): string => {
  const n = filamentNames(ct);
  const blocks: string[] = [];
  for (const f of ct.fields) {
    const a = aiOf(f);
    if (!a) continue;
    const col = snakeColumn(f.name);
    const phs = aiPlaceholders(a.prompt);
    const searches = phs.map((ph) => phpSingleQuoted(`{{${ph}}}`)).join(", ");
    const replaces = phs.map((ph) => `(string) $record->${snakeColumn(ph)}`).join(", ");
    const dirty =
      phs.length > 0
        ? phs.map((ph) => `$record->isDirty('${snakeColumn(ph)}')`).join(" || ")
        : "false";
    const model = a.model !== undefined ? phpSingleQuoted(a.model) : "null";
    blocks.push(`        if (${fireCondition(a.trigger, dirty)}) {
            $prompt = str_replace([${searches}], [${replaces}], ${phpSingleQuoted(a.prompt)});
            $record->${col} = Provider::generate(${model}, $prompt);
        }`);
  }
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Observers;

use App\\Ai\\Provider;
use App\\Models\\${n.model};

class ${n.model}Observer
{
    public function creating(${n.model} $record): void
    {
        $this->populateAi($record, true);
    }

    public function updating(${n.model} $record): void
    {
        $this->populateAi($record, false);
    }

    private function populateAi(${n.model} $record, bool $isCreate): void
    {
${blocks.join("\n")}
    }
}
`;
};
