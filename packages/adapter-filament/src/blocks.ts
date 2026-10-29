import type { GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { PHP_MARKER } from "./hooks/names";

/** Whether any content type or component holds a blocks field, so the editor's runtime is needed. */
export const hasBlocksFields = (doc: IrDocument): boolean =>
  [...doc.contentTypes, ...doc.components].some((t) => t.fields.some((f) => f.type === "blocks"));

const STRAPI_BLOCKS = `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

/**
 * Strapi's blocks rich text (a list of paragraph, heading, quote, code, list and image blocks
 * holding text and link nodes) to and from the document Filament's rich editor (TipTap) edits.
 * Blocks survive the round trip; what the editor writes is read back as Strapi's editor (Slate)
 * would have written it: adjacent texts of one format merged, an empty text either side of a
 * link that has no text there, a line break as a "\\n" in the text.
 */
final class StrapiBlocks
{
    /** Text flag → the editor's mark. */
    private const MARKS = [
        'bold' => 'bold',
        'italic' => 'italic',
        'underline' => 'underline',
        'strikethrough' => 'strike',
        'code' => 'code',
    ];

    /**
     * @param list<array<string, mixed>>|null $blocks
     * @return array<string, mixed>|null
     */
    public static function toEditor(?array $blocks): ?array
    {
        if ($blocks === null) {
            return null;
        }
        $content = [];
        foreach ($blocks as $block) {
            $content[] = self::blockToEditor($block);
        }

        return ['type' => 'doc', 'content' => $content];
    }

    /**
     * An editor document as blocks; an empty document is no value. \`$image\` finds the media
     * library's file for an image's URL, as Strapi's editor embeds it.
     *
     * @param array<string, mixed>|null $document
     * @param (\\Closure(string): ?array<string, mixed>)|null $image
     * @return list<array<string, mixed>>|null
     */
    public static function fromEditor(?array $document, ?\\Closure $image = null): ?array
    {
        $blocks = [];
        foreach (self::nodes($document) as $node) {
            array_push($blocks, ...self::blockFromEditor($node, $image));
        }
        $empty = $blocks === [] || ($blocks === [['type' => 'paragraph', 'children' => [['type' => 'text', 'text' => '']]]]);

        return $empty ? null : $blocks;
    }

    /** A document's text, one block to a line's worth, for a table column. */
    public static function plainText(mixed $blocks): string
    {
        $lines = [];
        foreach (is_array($blocks) ? $blocks : [] as $block) {
            $lines[] = trim(self::text(is_array($block) ? $block : []));
        }

        return trim(implode(' ', array_filter($lines, fn (string $line): bool => $line !== '')));
    }

    /** @param array<string, mixed> $node */
    private static function text(array $node): string
    {
        if (($node['type'] ?? null) === 'text') {
            return (string) ($node['text'] ?? '');
        }
        $parts = [];
        foreach ((array) ($node['children'] ?? []) as $child) {
            $parts[] = self::text(is_array($child) ? $child : []);
        }

        return implode(($node['type'] ?? null) === 'list' ? ' ' : '', $parts);
    }

    /**
     * @param array<string, mixed> $block
     * @return array<string, mixed>
     */
    private static function blockToEditor(array $block): array
    {
        $children = (array) ($block['children'] ?? []);

        return match ($block['type'] ?? null) {
            'heading' => ['type' => 'heading', 'attrs' => ['level' => (int) ($block['level'] ?? 1)], ...self::content(self::inlineToEditor($children))],
            'quote' => ['type' => 'blockquote', 'content' => [['type' => 'paragraph', ...self::content(self::inlineToEditor($children))]]],
            'code' => ['type' => 'codeBlock', 'attrs' => ['language' => $block['language'] ?? null], ...self::content(self::codeToEditor($children))],
            'list' => self::listToEditor($block),
            'image' => ['type' => 'image', 'attrs' => [
                'src' => $block['image']['url'] ?? null,
                'alt' => $block['image']['alternativeText'] ?? null,
                'title' => $block['image']['caption'] ?? null,
            ]],
            default => ['type' => 'paragraph', ...self::content(self::inlineToEditor($children))],
        };
    }

    /**
     * @param list<array<string, mixed>> $content
     * @return array<string, mixed>
     */
    private static function content(array $content): array
    {
        return $content === [] ? [] : ['content' => $content];
    }

    /**
     * @param array<int, mixed> $children
     * @return list<array<string, mixed>>
     */
    private static function codeToEditor(array $children): array
    {
        $text = implode('', array_map(fn (mixed $c): string => is_array($c) ? (string) ($c['text'] ?? '') : '', $children));

        return $text === '' ? [] : [['type' => 'text', 'text' => $text]];
    }

    /**
     * @param array<string, mixed> $list
     * @return array<string, mixed>
     */
    private static function listToEditor(array $list): array
    {
        $items = [];
        foreach ((array) ($list['children'] ?? []) as $child) {
            if (! is_array($child)) {
                continue;
            }
            if (($child['type'] ?? null) === 'list') {
                if ($items === []) {
                    $items[] = ['type' => 'listItem', 'content' => [['type' => 'paragraph']]];
                }
                $items[array_key_last($items)]['content'][] = self::listToEditor($child);

                continue;
            }
            $items[] = ['type' => 'listItem', 'content' => [['type' => 'paragraph', ...self::content(self::inlineToEditor((array) ($child['children'] ?? [])))]]];
        }

        return ['type' => ($list['format'] ?? null) === 'ordered' ? 'orderedList' : 'bulletList', 'content' => $items];
    }

    /**
     * @param array<int, mixed> $children
     * @return list<array<string, mixed>>
     */
    private static function inlineToEditor(array $children, ?string $href = null): array
    {
        $out = [];
        foreach ($children as $child) {
            if (! is_array($child)) {
                continue;
            }
            if (($child['type'] ?? null) === 'link') {
                array_push($out, ...self::inlineToEditor((array) ($child['children'] ?? []), (string) ($child['url'] ?? '')));

                continue;
            }
            $marks = [];
            foreach (self::MARKS as $flag => $mark) {
                if (($child[$flag] ?? false) === true) {
                    $marks[] = ['type' => $mark];
                }
            }
            if ($href !== null) {
                $marks[] = ['type' => 'link', 'attrs' => ['href' => $href]];
            }
            foreach (explode("\\n", (string) ($child['text'] ?? '')) as $i => $line) {
                if ($i > 0) {
                    $out[] = ['type' => 'hardBreak'];
                }
                if ($line !== '') {
                    $out[] = ['type' => 'text', 'text' => $line, ...($marks === [] ? [] : ['marks' => $marks])];
                }
            }
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $node
     * @param (\\Closure(string): ?array<string, mixed>)|null $image
     * @return list<array<string, mixed>>
     */
    private static function blockFromEditor(array $node, ?\\Closure $image): array
    {
        $inline = fn (array $n): array => self::inlineFromEditor(self::nodes($n));

        return match ($node['type'] ?? null) {
            'paragraph' => [['type' => 'paragraph', 'children' => $inline($node)]],
            'heading' => [['type' => 'heading', 'level' => max(1, min(6, (int) ($node['attrs']['level'] ?? 1))), 'children' => $inline($node)]],
            'blockquote' => [['type' => 'quote', 'children' => self::inlineFromEditor(self::lines(self::nodes($node)))]],
            'codeBlock' => [[
                'type' => 'code',
                ...(isset($node['attrs']['language']) ? ['language' => (string) $node['attrs']['language']] : []),
                'children' => [['type' => 'text', 'text' => implode('', array_map(fn (array $t): string => (string) ($t['text'] ?? ''), self::nodes($node)))]],
            ]],
            'bulletList', 'orderedList' => [self::listFromEditor($node, 0)],
            'image' => [self::imageFromEditor($node, $image)],
            default => [],
        };
    }

    /**
     * The inline nodes of several paragraphs, one line each.
     *
     * @param list<array<string, mixed>> $paragraphs
     * @return list<array<string, mixed>>
     */
    private static function lines(array $paragraphs): array
    {
        $out = [];
        foreach ($paragraphs as $i => $paragraph) {
            if ($i > 0) {
                $out[] = ['type' => 'hardBreak'];
            }
            array_push($out, ...self::nodes($paragraph));
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $list
     * @return array<string, mixed>
     */
    private static function listFromEditor(array $list, int $depth): array
    {
        $children = [];
        foreach (self::nodes($list) as $item) {
            $nested = [];
            $paragraphs = [];
            foreach (self::nodes($item) as $part) {
                if (in_array($part['type'] ?? null, ['bulletList', 'orderedList'], true)) {
                    $nested[] = self::listFromEditor($part, $depth + 1);
                } else {
                    $paragraphs[] = $part;
                }
            }
            $children[] = ['type' => 'list-item', 'children' => self::inlineFromEditor(self::lines($paragraphs))];
            array_push($children, ...$nested);
        }

        return [
            'type' => 'list',
            'format' => ($list['type'] ?? null) === 'orderedList' ? 'ordered' : 'unordered',
            ...($depth > 0 ? ['indentLevel' => $depth] : []),
            'children' => $children,
        ];
    }

    /**
     * @param array<string, mixed> $node
     * @param (\\Closure(string): ?array<string, mixed>)|null $image
     * @return array<string, mixed>
     */
    private static function imageFromEditor(array $node, ?\\Closure $image): array
    {
        $src = (string) ($node['attrs']['src'] ?? '');
        $file = $image !== null && $src !== '' ? $image($src) : null;

        return [
            'type' => 'image',
            'image' => $file ?? [
                'url' => $src,
                'alternativeText' => $node['attrs']['alt'] ?? null,
                'caption' => $node['attrs']['title'] ?? null,
            ],
            'children' => [['type' => 'text', 'text' => '']],
        ];
    }

    /**
     * @param list<array<string, mixed>> $nodes
     * @return list<array<string, mixed>>
     */
    private static function inlineFromEditor(array $nodes): array
    {
        $out = [];
        foreach ($nodes as $node) {
            $type = $node['type'] ?? null;
            if ($type === 'hardBreak') {
                $last = array_key_last($out);
                if ($last !== null && ($out[$last]['type'] ?? null) === 'text') {
                    $out[$last]['text'] .= "\\n";
                } else {
                    $out[] = ['type' => 'text', 'text' => "\\n"];
                }

                continue;
            }
            if ($type !== 'text') {
                continue;
            }
            $text = ['type' => 'text', 'text' => (string) ($node['text'] ?? '')];
            $href = null;
            foreach ((array) ($node['marks'] ?? []) as $mark) {
                $flag = array_search($mark['type'] ?? null, self::MARKS, true);
                if ($flag !== false) {
                    $text[$flag] = true;
                } elseif (($mark['type'] ?? null) === 'link') {
                    $href = (string) ($mark['attrs']['href'] ?? '');
                }
            }
            $text = self::ordered($text);
            $last = array_key_last($out);
            if ($href !== null) {
                if ($last !== null && ($out[$last]['type'] ?? null) === 'link' && $out[$last]['url'] === $href) {
                    $out[$last]['children'] = self::merge($out[$last]['children'], $text);
                } else {
                    $out[] = ['type' => 'link', 'url' => $href, 'children' => [$text]];
                }

                continue;
            }
            $out = self::merge($out, $text);
        }

        return self::padLinks($out);
    }

    /**
     * A text node's flags in Strapi's order.
     *
     * @param array<string, mixed> $text
     * @return array<string, mixed>
     */
    private static function ordered(array $text): array
    {
        $out = ['type' => 'text', 'text' => $text['text']];
        foreach (array_keys(self::MARKS) as $flag) {
            if (isset($text[$flag])) {
                $out[$flag] = true;
            }
        }

        return $out;
    }

    /**
     * Append a text, merged into the last one when it has the same format.
     *
     * @param list<array<string, mixed>> $nodes
     * @param array<string, mixed> $text
     * @return list<array<string, mixed>>
     */
    private static function merge(array $nodes, array $text): array
    {
        $last = array_key_last($nodes);
        if ($last !== null && ($nodes[$last]['type'] ?? null) === 'text'
            && array_diff_key($nodes[$last], ['text' => true]) == array_diff_key($text, ['text' => true])) {
            $nodes[$last]['text'] .= $text['text'];

            return $nodes;
        }
        $nodes[] = $text;

        return $nodes;
    }

    /**
     * Slate keeps a text either side of every link: an empty one where there is none.
     *
     * @param list<array<string, mixed>> $nodes
     * @return list<array<string, mixed>>
     */
    private static function padLinks(array $nodes): array
    {
        $out = [];
        foreach ($nodes as $node) {
            $previous = $out === [] ? null : $out[array_key_last($out)]['type'];
            if ($node['type'] === 'link' && $previous !== 'text') {
                $out[] = ['type' => 'text', 'text' => ''];
            }
            $out[] = $node;
        }
        if ($out === [] || $out[array_key_last($out)]['type'] === 'link') {
            $out[] = ['type' => 'text', 'text' => ''];
        }

        return $out;
    }

    /**
     * A node's child nodes (a document's blocks, a block's inline nodes).
     *
     * @param array<string, mixed>|null $node
     * @return list<array<string, mixed>>
     */
    private static function nodes(?array $node): array
    {
        return array_values(array_filter((array) ($node['content'] ?? []), 'is_array'));
    }
}
`;

/** The model's blocks list in the editor's JSON document and back. */
const blocksStateCast = (media: boolean): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Filament\\Forms;

${media ? "use App\\Http\\Serializers\\FileSerializer;\nuse App\\Models\\File;\n" : ""}use App\\Support\\StrapiBlocks;
use Filament\\Forms\\Components\\RichEditor\\StateCasts\\RichEditorStateCast;
use Filament\\Schemas\\Components\\StateCasts\\Contracts\\StateCast;

/**
 * Wraps the rich editor's own cast: the model holds a blocks list, the editor a document. A state
 * that is already a document (the editor's own, between requests) passes through.
 */
final class BlocksStateCast implements StateCast
{
    public function __construct(private readonly RichEditorStateCast $editor) {}

    public function get(mixed $state): mixed
    {
        $document = $this->editor->get($state);

        return StrapiBlocks::fromEditor(is_array($document) ? $document : null, ${media ? "self::image(...)" : "null"});
    }

    public function set(mixed $state): mixed
    {
        return $this->editor->set(is_array($state) && array_is_list($state) ? StrapiBlocks::toEditor($state) : $state);
    }${
      media
        ? `

    /** @return array<string, mixed>|null the media library's file at a URL, as Strapi embeds it */
    private static function image(string $url): ?array
    {
        $file = File::query()->where('url', $url)->first();

        return $file === null ? null : FileSerializer::toWire($file);
    }`
        : ""
    }
}
`;

const BLOCKS_EDITOR = `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Filament\\Forms;

use Filament\\Forms\\Components\\RichEditor;
use Filament\\Forms\\Components\\RichEditor\\StateCasts\\RichEditorStateCast;
use Filament\\Schemas\\Components\\StateCasts\\Contracts\\StateCast;

/** A blocks field in Filament's rich editor, with the tools for what blocks can hold. */
class BlocksEditor extends RichEditor
{
    protected function setUp(): void
    {
        parent::setUp();

        $this->json();
        $this->toolbarButtons([
            ['bold', 'italic', 'underline', 'strike', 'code', 'link'],
            ['h1', 'h2', 'h3'],
            ['blockquote', 'codeBlock', 'bulletList', 'orderedList'],
            ['undo', 'redo'],
        ]);
    }

    /** @return array<StateCast> */
    public function getDefaultStateCasts(): array
    {
        return array_map(
            fn (StateCast $cast): StateCast => $cast instanceof RichEditorStateCast ? new BlocksStateCast($cast) : $cast,
            parent::getDefaultStateCasts(),
        );
    }
}
`;

/** The blocks editor's runtime; `media` says image blocks are found in the media library. */
export const emitBlocksFiles = (media: boolean): GeneratedFile[] => [
  { path: "app/Support/StrapiBlocks.php", content: STRAPI_BLOCKS },
  { path: "app/Filament/Forms/BlocksEditor.php", content: BLOCKS_EDITOR },
  { path: "app/Filament/Forms/BlocksStateCast.php", content: blocksStateCast(media) },
];
