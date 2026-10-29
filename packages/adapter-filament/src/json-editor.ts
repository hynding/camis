import type { GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { PHP_MARKER } from "./hooks/names";

/** Whether any content type or component holds a json field, so the admin needs its editor. */
export const hasJsonFields = (doc: IrDocument): boolean =>
  [...doc.contentTypes, ...doc.components].some((t) => t.fields.some((f) => f.type === "json"));

const JSON_TEXT = `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

/**
 * A json field's value as the text the admin edits, and back. Objects stay objects (\`{}\` is not
 * \`[]\`), so saving an entry stores exactly the value it was shown.
 */
final class JsonText
{
    public static function toText(mixed $value): ?string
    {
        return $value === null
            ? null
            : (string) json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    }

    /** Text that is not JSON is kept as it is, for validation to refuse. */
    public static function fromText(mixed $text): mixed
    {
        if (! is_string($text) || trim($text) === '') {
            return null;
        }

        return json_validate($text) ? json_decode($text) : $text;
    }
}
`;

const JSON_EDITOR = `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Filament\\Forms;

use App\\Support\\JsonText;
use Closure;
use Filament\\Forms\\Components\\Textarea;
use Illuminate\\Database\\Eloquent\\Model;

/** A json field as JSON text: any value Strapi's json attribute holds, not only a flat map. */
class JsonEditor extends Textarea
{
    protected function setUp(): void
    {
        parent::setUp();

        $this->rows(8);
        $this->extraInputAttributes(['class' => 'font-mono'], merge: true);
        // The stored text, not the model's array cast, which reads an empty object as a list.
        $this->formatStateUsing(function (JsonEditor $component, mixed $state, ?Model $record): ?string {
            $raw = $record?->getRawOriginal($component->getName());

            return JsonText::toText(is_string($raw) ? json_decode($raw) : $state);
        });
        $this->dehydrateStateUsing(fn (mixed $state): mixed => JsonText::fromText($state));
        $this->rule(fn (): Closure => function (string $attribute, mixed $value, Closure $fail): void {
            if (is_string($value) && trim($value) !== '' && ! json_validate($value)) {
                $fail('The :attribute field must be valid JSON.');
            }
        });
    }
}
`;

export const emitJsonEditorFiles = (): GeneratedFile[] => [
  { path: "app/Support/JsonText.php", content: JSON_TEXT },
  { path: "app/Filament/Forms/JsonEditor.php", content: JSON_EDITOR },
];
