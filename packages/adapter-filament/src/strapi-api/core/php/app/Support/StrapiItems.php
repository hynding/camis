<?php

declare(strict_types=1);

namespace App\Support;

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
