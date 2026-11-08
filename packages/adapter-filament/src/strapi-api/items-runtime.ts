import { PHP_MARKER } from "../hooks/names";
import type { WireChild, WireShape } from "./wire-shape";

export const ITEMS_PATH = "app/Support/StrapiItems.php";

/** Whether a repeatable's items link anything (files, relations) or hold items of their own. */
export const itemsLinkAnything = (c: WireChild): boolean =>
  c.media.length > 0 || c.relations.length > 0 || c.children.length > 0;

/** Whether a type writes items one by one: a repeatable's that link anything, or a zone's. */
export const writesItems = (shape: WireShape): boolean =>
  shape.children.some(itemsLinkAnything) || shape.zones.length > 0;

/**
 * A repeatable component's items written one by one, as Strapi writes a component: each item's
 * columns, then its links (its to-one keys before it is saved, its files and to-many links once it
 * has an id), then the items of the repeatables inside it, all the way down. A write replaces a
 * repeatable's items whole, as Strapi replaces a component sent without its id.
 */
export const emitStrapiItems = (): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n` +
  String.raw`
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

final class StrapiItems
{
    /**
     * Replaces the items $items holds with $rows. With $oneByOne the old items are deleted one at
     * a time, so the files they (or items inside them) link are unlinked with them.
     *
     * @param list<array<string, mixed>> $rows each item's columns, its resolved '__links' and its '__children'
     */
    public static function replace(HasMany $items, array $rows, bool $oneByOne): void
    {
        $oneByOne ? $items->get()->each->delete() : $items->delete();
        foreach ($rows as $row) {
            self::make($items, $row);
        }
    }

    /** One item: its columns, its links and the items inside it. */
    public static function make(HasMany $items, array $row): Model
    {
        $item = $items->make(array_diff_key($row, ['__links' => true, '__children' => true]));
        self::write($item, $row);

        return $item;
    }

    /** Saves an item made or kept, with the links and nested items its row names. */
    public static function write(Model $item, array $row): void
    {
        $links = $row['__links'] ?? [];
        StrapiRelations::associate($item, $links);
        $item->save();
        StrapiRelations::link($item, $links);
        foreach ($row['__children'] ?? [] as $relation => $rows) {
            self::replace($item->{$relation}(), $rows, true);
        }
    }
}
`;
