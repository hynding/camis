<?php

declare(strict_types=1);

namespace App\Support;

use Closure;
use Filament\Forms\Components\Select;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\Relations\HasOneOrMany;
use Illuminate\Validation\ValidationException;

/**
 * A relation picked in the admin on its side that holds no key (a one-to-many's many, a
 * one-to-one's inverse), as Strapi's edit view links entries from either side of a relation. The
 * linked rows are read in link order; a save writes their keys one by one: each row picked that
 * was not linked joins the end of the list (its link order, where its type keeps one, as Strapi's
 * relation picker appends), and each row taken off is unlinked. Only the link changes: the rows'
 * own timestamps and events are left alone, as a link is not an edit of the linked entry.
 *
 * $narrow keeps to the rows a link is made on (a draft-and-publish type's drafts, a localized
 * type's rows in the entry's locale).
 */
final class InverseLinks
{
    /** @return list<int|string>|int|string|null the linked rows' keys; one key, or none, for a one-to-one */
    public static function linked(HasOneOrMany $relation, ?Closure $narrow = null): array|int|string|null
    {
        $related = $relation->getRelated();
        $query = self::rows($relation, $narrow)->where($relation->getForeignKeyName(), $relation->getParentKey());
        $order = self::orderColumn($relation);
        if ($order !== null) {
            $wrapped = $query->getQuery()->getGrammar()->wrap($order);
            $query->orderByRaw("CASE WHEN {$wrapped} IS NULL THEN 1 ELSE 0 END")->orderBy($order);
        }
        /** @var list<int|string> $keys */
        $keys = $query->orderBy($related->getKeyName())->pluck($related->getKeyName())->all();

        return $relation instanceof HasOne ? ($keys[0] ?? null) : $keys;
    }

    /**
     * Links the rows the picker holds and unlinks the others. A required key cannot be emptied, so
     * taking a row off is refused there: it has to be linked elsewhere first.
     *
     * @throws ValidationException when a required link would be taken off
     */
    public static function sync(Select $component, HasOneOrMany $relation, mixed $state, ?Closure $narrow = null, bool $required = false): void
    {
        $keyName = $relation->getRelated()->getKeyName();
        $foreignKey = $relation->getForeignKeyName();
        $parent = $relation->getParentKey();
        $order = self::orderColumn($relation);
        $picked = array_values(array_unique(array_map(
            fn (mixed $key): string => (string) $key,
            array_filter(is_array($state) ? $state : [$state], fn (mixed $key): bool => is_int($key) || (is_string($key) && $key !== '')),
        )));

        $dropped = self::rows($relation, $narrow)->where($foreignKey, $parent)->whereNotIn($keyName, $picked)->pluck($keyName)->all();
        if ($dropped !== [] && $required) {
            throw ValidationException::withMessages([
                $component->getStatePath() => 'An entry cannot be left without this relation: link it to another one from its own page first.',
            ]);
        }
        if ($dropped !== []) {
            self::rows($relation, $narrow)->whereIn($keyName, $dropped)->toBase()->update([$foreignKey => null] + ($order === null ? [] : [$order => null]));
        }

        foreach ($picked as $key) {
            $row = self::rows($relation, $narrow)->whereKey($key)->first();
            if ($row === null || (string) $row->getAttribute($foreignKey) === (string) $parent) {
                continue;
            }
            $values = [$foreignKey => $parent];
            if ($order !== null) {
                $values[$order] = (float) (self::rows($relation, null)->where($foreignKey, $parent)->max($order) ?? 0) + 1;
            }
            self::rows($relation, $narrow)->whereKey($key)->toBase()->update($values);
        }
    }

    /** @return Builder<Model> the related type's rows a link is made on */
    private static function rows(HasOneOrMany $relation, ?Closure $narrow): Builder
    {
        $query = $relation->getRelated()->newQuery();
        if ($narrow !== null) {
            $narrow($query);
        }

        return $query;
    }

    /** The column keeping the related rows' order in the list they join (Strapi's `<field>_ord`), if their type keeps one. */
    private static function orderColumn(HasOneOrMany $relation): ?string
    {
        $related = $relation->getRelated();
        $orders = defined($related::class.'::LINK_ORDERS') ? constant($related::class.'::LINK_ORDERS') : [];

        return is_array($orders) && is_string($orders[$relation->getForeignKeyName()] ?? null) ? $orders[$relation->getForeignKeyName()] : null;
    }
}
