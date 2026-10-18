import { PHP_MARKER } from "../hooks/names";

const header = (namespace: string): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace ${namespace};\n`;

/**
 * Strapi 5's document model for a `draftPublish` type: every document has a draft row, which every
 * write goes through, and once published a second row with `published_at` set. Publishing copies
 * the draft over the published row — columns, repeatable components and the links this type holds
 * — mapping each link to a draft-and-publish target onto that target's published version, so a
 * published document only ever links published ones (strapi-php's document service does the
 * same). The published row is updated in place on republish, which keeps links other rows hold to
 * it. The canonical check is `draft-publish-vectors.json`, recorded from strapi-php.
 */
export const emitStrapiDocuments = (): string =>
  header("App\\Support") +
  String.raw`
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/** $serializer is a generated serializer class: its FIELDS say which links the row holds. */
final class StrapiDocuments
{
    /** Strapi's status parameter: anything but 'published' (the default) asks for drafts. */
    public static function draftOnly(array $params): bool
    {
        return array_key_exists('status', $params) && $params['status'] !== 'published';
    }

    /** Narrows a query to the version the status parameter names. */
    public static function version(Builder $query, array $params): Builder
    {
        return self::withStatus($query, ! self::draftOnly($params));
    }

    public static function withStatus(Builder $query, bool $published): Builder
    {
        $column = $query->qualifyColumn('published_at');

        return $published ? $query->whereNotNull($column) : $query->whereNull($column);
    }

    /** A document's draft row, the one every write goes through. */
    public static function draft(Builder $query, string $documentId): ?Model
    {
        return $query->where($query->qualifyColumn('document_id'), $documentId)
            ->whereNull($query->qualifyColumn('published_at'))
            ->first();
    }

    public static function publish(Model $draft, string $serializer): Model
    {
        return DB::transaction(fn () => self::copy($draft, self::sibling($draft, true), $serializer, true));
    }

    /** Drops the published version; the draft stays. */
    public static function unpublish(Model $draft): void
    {
        self::sibling($draft, true)?->delete();
    }

    /** Resets the draft to the published version. */
    public static function discard(Model $draft, string $serializer): Model
    {
        $published = self::sibling($draft, true);
        if ($published === null) {
            return $draft;
        }

        return DB::transaction(fn () => self::copy($published, $draft, $serializer, false));
    }

    /** Deletes every version of the document. */
    public static function destroy(Model $row): void
    {
        DB::transaction(function () use ($row): void {
            $row->newQuery()->where('document_id', $row->getAttribute('document_id'))->get()->each->delete();
        });
    }

    /** Draft, Published, or Modified (a draft edited since it was published), for the admin. */
    public static function status(Model $draft): string
    {
        $published = $draft->relationLoaded('publishedVersion') ? $draft->getRelation('publishedVersion') : self::sibling($draft, true);
        if ($published === null) {
            return 'Draft';
        }

        return $draft->getAttribute('updated_at') > $published->getAttribute('updated_at') ? 'Modified' : 'Published';
    }

    private static function sibling(Model $row, bool $published): ?Model
    {
        $query = $row->newQuery()->where('document_id', $row->getAttribute('document_id'));

        return ($published ? $query->whereNotNull('published_at') : $query->whereNull('published_at'))->first();
    }

    /** One version over another (created when $to is null), with its children and held links. */
    private static function copy(Model $from, ?Model $to, string $serializer, bool $published): Model
    {
        $to ??= $from->newInstance();
        $attributes = $from->getAttributes();
        unset($attributes[$from->getKeyName()]);
        $to->forceFill($attributes);
        $to->setAttribute('published_at', $published ? now() : null);
        foreach ($serializer::FIELDS as $field) {
            if (($field['kind'] ?? null) === 'belongsTo') {
                $fk = $field['foreignKey'];
                $to->setAttribute($fk, self::counterparts($field, array_filter([$from->getAttribute($fk)]), $published)[0] ?? null);
            }
        }
        $to->save();
        foreach ($serializer::FIELDS as $field) {
            if (isset($field['component'])) {
                $to->{$field['component']}()->delete();
                foreach ($from->{$field['component']}()->orderBy('id')->get() as $child) {
                    $to->{$field['component']}()->save($child->replicate());
                }
            } elseif (($field['kind'] ?? null) === 'belongsToMany' && $field['holder'] === 'self') {
                $relation = $from->{$field['relation']}();
                $ids = $relation->orderBy($relation->getRelated()->getQualifiedKeyName())->pluck($relation->getRelated()->getQualifiedKeyName())->all();
                $to->{$field['relation']}()->sync(self::counterparts($field, $ids, $published));
            }
        }

        return $to;
    }

    /**
     * Link targets as the version being written should hold them: a draft-and-publish target's
     * row of the same status (dropped when it has none), anything else unchanged.
     *
     * @return list<int>
     */
    private static function counterparts(array $relation, array $ids, bool $published): array
    {
        $ids = array_values(array_map('intval', $ids));
        if (! $relation['draftPublish'] || $ids === []) {
            return $ids;
        }
        $documents = $relation['model']::query()->whereKey($ids)->pluck('document_id', 'id');
        $versions = $relation['model']::query()
            ->whereIn('document_id', $documents->unique()->values()->all())
            ->{$published ? 'whereNotNull' : 'whereNull'}('published_at')
            ->pluck('id', 'document_id');
        $mapped = [];
        foreach ($ids as $id) {
            $version = $versions[$documents[$id] ?? ''] ?? null;
            if ($version !== null) {
                $mapped[] = (int) $version;
            }
        }

        return $mapped;
    }
}
`;

/** The model half: the published_at cast and the published sibling the admin lists with. */
export const emitHasDraftAndPublish = (): string =>
  header("App\\Models\\Concerns") +
  String.raw`
use Illuminate\Database\Eloquent\Relations\HasOne;

trait HasDraftAndPublish
{
    public function initializeHasDraftAndPublish(): void
    {
        $this->mergeCasts(['published_at' => 'datetime']);
    }

    /** The document's published row, from its draft. */
    public function publishedVersion(): HasOne
    {
        return $this->hasOne(static::class, 'document_id', 'document_id')->whereNotNull('published_at');
    }
}
`;
