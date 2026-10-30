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
use App\Models\Concerns\HasLocale;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Support\Facades\DB;

/** $serializer is a generated serializer class: its FIELDS and ZONES say which children and links the row holds. */
final class StrapiDocuments
{
    public const PUBLICATION_FILTERS = [
        'never-published',
        'has-published-version',
        'modified',
        'unmodified',
        'never-published-document',
        'has-published-version-document',
        'published-without-draft',
        'published-with-draft',
    ];

    /** Strapi's status parameter: anything but 'published' (the default) asks for drafts. */
    public static function draftOnly(array $params): bool
    {
        return array_key_exists('status', $params) && $params['status'] !== 'published';
    }

    /** Narrows a query to the version the status parameter names, and to its publicationFilter. */
    public static function version(Builder $query, array $params): Builder
    {
        $published = ! self::draftOnly($params);
        self::withStatus($query, $published);
        $cohort = self::publicationFilter($params);

        return $cohort === null ? $query : self::cohort($query, $cohort, $published);
    }

    /**
     * Strapi's publicationFilter parameter, or the cohort its deprecated hasPublishedVersion names
     * (which is document-scoped); a value Strapi does not know is refused, on any type.
     */
    public static function publicationFilter(array $params): ?string
    {
        $mode = $params['publicationFilter'] ?? null;
        if ($mode !== null && ! in_array($mode, self::PUBLICATION_FILTERS, true)) {
            throw StrapiError::validation("Invalid value for 'publicationFilter'. Expected one of: ".implode(', ', self::PUBLICATION_FILTERS).'.');
        }
        $legacy = $params['hasPublishedVersion'] ?? null;
        if ($legacy !== null && ! in_array($legacy, ['true', 'false'], true)) {
            throw StrapiError::validation("Invalid value for 'hasPublishedVersion'. Expected boolean or 'true'/'false' string.");
        }
        if ($mode !== null || $legacy === null) {
            return $mode;
        }

        return $legacy === 'true' ? 'has-published-version-document' : 'never-published-document';
    }

    /**
     * Narrows rows of one status to a publicationFilter cohort by whether the other version of
     * the same document exists: in the same locale, unless the mode is document-scoped
     * ('-document'); modified and unmodified compare the two versions' updated_at. A mode
     * the status cannot satisfy, such as published versions that were never published, is empty.
     */
    public static function cohort(Builder $query, string $mode, bool $published): Builder
    {
        $wanted = match ($mode) {
            'never-published', 'never-published-document' => $published ? null : false,
            'published-without-draft' => $published ? false : null,
            'published-with-draft' => $published ? true : null,
            default => true,
        };
        if ($wanted === null) {
            return $query->whereRaw('1 = 0');
        }
        $model = $query->getModel();
        $paired = ! str_ends_with($mode, '-document') && in_array(HasLocale::class, class_uses_recursive($model), true);
        $newer = ['modified' => '>', 'unmodified' => '<='][$mode] ?? null;
        $other = function (QueryBuilder $sub) use ($query, $model, $published, $paired, $newer): void {
            $sub->selectRaw('1')
                ->from($model->getTable().' as camis_other')
                ->whereColumn('camis_other.document_id', $query->qualifyColumn('document_id'));
            $published ? $sub->whereNull('camis_other.published_at') : $sub->whereNotNull('camis_other.published_at');
            if ($paired) {
                $sub->whereColumn('camis_other.locale', $query->qualifyColumn('locale'));
            }
            if ($newer !== null) {
                [$draft, $live] = $published ? ['camis_other.updated_at', $query->qualifyColumn('updated_at')] : [$query->qualifyColumn('updated_at'), 'camis_other.updated_at'];
                $sub->whereColumn($draft, $newer, $live);
            }
        };

        return $wanted ? $query->whereExists($other) : $query->whereNotExists($other);
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

    /** Each version's own write is not an event: the documents send what Strapi sends for it. */
    public static function publish(Model $draft, string $serializer): Model
    {
        $published = StrapiWebhooks::quietly(fn () => DB::transaction(fn () => self::copy($draft, self::sibling($draft, true), $serializer, true)));
        StrapiWebhooks::entry('entry.publish', $published);

        return $published;
    }

    /** Drops the published version; the draft stays. */
    public static function unpublish(Model $draft): void
    {
        $published = self::sibling($draft, true);
        if ($published === null) {
            return;
        }
        StrapiWebhooks::quietly(fn () => $published->delete());
        StrapiWebhooks::entry('entry.unpublish', $published);
    }

    /** Resets the draft to the published version. */
    public static function discard(Model $draft, string $serializer): Model
    {
        $published = self::sibling($draft, true);
        if ($published === null) {
            return $draft;
        }
        $draft = StrapiWebhooks::quietly(fn () => DB::transaction(fn () => self::copy($published, $draft, $serializer, false)));
        StrapiWebhooks::entry('entry.draft-discard', $draft);

        return $draft;
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

    /** The document's other version, in the same locale when the type keeps locales. */
    private static function sibling(Model $row, bool $published): ?Model
    {
        $query = $row->newQuery()->where('document_id', $row->getAttribute('document_id'));
        if ($row->getAttribute('locale') !== null) {
            $query->where('locale', $row->getAttribute('locale'));
        }

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
                // One by one, so an item's links to files go with it.
                $to->{$field['component']}()->get()->each->delete();
                foreach ($from->{$field['component']}()->orderBy('id')->get() as $child) {
                    $copy = $child->replicate();
                    $to->{$field['component']}()->save($copy);
                    foreach ($field['fields'] as $inner) {
                        if (in_array($inner['kind'] ?? null, ['mediaOne', 'mediaMany'], true)) {
                            self::copyFiles($child, $copy, $inner['relation']);
                        }
                    }
                }
            } elseif (in_array($field['kind'] ?? null, ['mediaOne', 'mediaMany'], true)) {
                self::copyFiles($from, $to, $field['relation']);
            } elseif (($field['kind'] ?? null) === 'belongsToMany' && $field['holder'] === 'self') {
                $relation = $from->{$field['relation']}();
                if (($field['order'] ?? null) !== null) {
                    StrapiLinkOrder::sort($relation, $relation->qualifyPivotColumn($field['order']));
                }
                $ids = $relation->orderBy($relation->getRelated()->getQualifiedKeyName())->pluck($relation->getRelated()->getQualifiedKeyName())->all();
                $targets = self::counterparts($field, $ids, $published);
                // The version written keeps the links in the order the other one holds them.
                ($field['order'] ?? null) !== null
                    ? StrapiLinkOrder::write($to, $to->{$field['relation']}(), ['relation' => $field, 'set' => $targets, 'connect' => [], 'disconnect' => []])
                    : $to->{$field['relation']}()->sync($targets);
            }
        }
        foreach ($serializer::ZONES as $members) {
            foreach ($members as $member) {
                $to->{$member['relation']}()->delete();
                foreach ($from->{$member['relation']}()->orderBy('position')->get() as $item) {
                    $to->{$member['relation']}()->save($item->replicate());
                }
            }
        }

        return $to;
    }

    /** The files one row's media field links, linked from another row in the same order. */
    private static function copyFiles(Model $from, Model $to, string $relation): void
    {
        $media = $from->{$relation}()->orderByPivot('order');
        $to->{$relation}()->sync(StrapiRelations::ordered($media->pluck($media->getRelated()->getQualifiedKeyName())->all()));
    }

    /**
     * Link targets as the version being written should hold them: a draft-and-publish target's
     * row of the same status and locale (dropped when it has none), anything else unchanged.
     *
     * @return list<int>
     */
    private static function counterparts(array $relation, array $ids, bool $published): array
    {
        $ids = array_values(array_map('intval', $ids));
        if (! $relation['draftPublish'] || $ids === []) {
            return $ids;
        }
        $columns = $relation['localized'] ? ['document_id', 'locale'] : ['document_id'];
        $linked = $relation['model']::query()->whereKey($ids)->get(['id', ...$columns])->keyBy('id');
        $versions = $relation['model']::query()
            ->whereIn('document_id', $linked->pluck('document_id')->unique()->values()->all())
            ->{$published ? 'whereNotNull' : 'whereNull'}('published_at')
            ->get(['id', ...$columns])
            ->keyBy(fn (Model $row) => self::versionKey($row, $columns));
        $mapped = [];
        foreach ($ids as $id) {
            $row = $linked[$id] ?? null;
            $version = $row === null ? null : ($versions[self::versionKey($row, $columns)] ?? null);
            if ($version !== null) {
                $mapped[] = (int) $version->getKey();
            }
        }

        return $mapped;
    }

    /**
     * What a document's versions share: its documentId and, for a type that keeps locales, its
     * locale.
     *
     * @param list<string> $columns
     */
    public static function versionKey(Model $row, array $columns): string
    {
        return implode('|', array_map(fn (string $column): string => (string) $row->getAttribute($column), $columns));
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
        $published = $this->hasOne(static::class, 'document_id', 'document_id')->whereNotNull('published_at');

        // Lazily loaded only: an eager load would apply the first row's locale to every row.
        return $this->getAttribute('locale') === null ? $published : $published->where('locale', $this->getAttribute('locale'));
    }
}
`;
