<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\AdminUser;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/**
 * The content-manager's MCP tools: Strapi's Content Manager reached through a tool call, acting as
 * the admin token's owner. A document comes back as the Content Manager answers one: its fields,
 * then its timestamps and locale, then its links reduced to the documents they name, its authors,
 * its localizations and its status, with the versions it has in its other statuses and locales.
 * A write answers before reading its links back, as Strapi's does, so they show as none.
 *
 * $type is the content type's entry of resources/strapi/mcp.json: its model, serializer, kind,
 * draft & publish and locales, its fields in Strapi's order and the populate that reads them.
 */
final class StrapiMcpContentManager
{
    /** @param array<string, mixed> $type */
    private function __construct(private readonly array $type, private readonly AdminUser $owner)
    {
    }

    /**
     * @param  array<string, mixed>  $tool
     * @param  array<string, mixed>  $type
     * @param  array<string, mixed>  $args
     * @return array<string, mixed>
     */
    public static function call(array $tool, array $type, array $args, AdminUser $owner): array
    {
        $handler = new self($type, $owner);

        return StrapiQuery::unrestricted(fn (): array => match ($tool['operation']) {
            'list' => $handler->list($args),
            'get' => $handler->get($args),
            'create' => $handler->create($args),
            'update' => $handler->update($args),
            'write' => $handler->write($args),
            'delete' => $handler->delete($args),
            'publish' => $handler->publish($args),
            'unpublish' => $handler->unpublish($args),
            'discard_draft' => $handler->discard($args),
            default => throw new StrapiMcpError(0, "Unknown content-manager operation {$tool['operation']}"),
        });
    }

    // --------------------------------------------------------------------------------- the tools

    /** @return array<string, mixed> */
    private function list(array $args): array
    {
        $query = $this->versions($this->query(), $this->locale($args), $this->published($args));
        $params = array_filter([
            'filters' => $args['filters'] ?? null,
            'sort' => $args['sort'] ?? null,
            'pagination' => ['page' => $args['page'] ?? 1, 'pageSize' => $args['pageSize'] ?? 10],
        ], fn ($v) => $v !== null);
        $found = StrapiQuery::find($query, $params, $this->serializer()::FIELDS);
        $results = [];
        foreach ($found['rows'] as $row) {
            $results[] = $this->document($row, links: true, listed: true);
        }

        return ['results' => $results, 'pagination' => $found['pagination']];
    }

    /** @return array<string, mixed> */
    private function get(array $args): array
    {
        $documentId = $this->documentId($args);
        $locale = $this->locale($args);
        $published = $this->published($args);
        $row = $documentId === null ? null : $this->version($documentId, $locale, $published);
        if ($row === null) {
            return $this->missing($documentId, $locale, $published);
        }

        return $this->answer($row, links: true);
    }

    /** @return array<string, mixed> */
    private function create(array $args, ?string $documentId = null): array
    {
        $locale = $this->locale($args);
        $data = $this->data($args);
        $serializer = $this->serializer();
        $wire = $serializer::fromWire($data);
        $links = StrapiRelations::read($data, $serializer::FIELDS, null, $locale);
        $model = $this->type['model'];
        $row = new $model($wire['columns']);
        if ($documentId !== null) {
            $row->setAttribute('document_id', $documentId);
        }
        if ($locale !== null) {
            $row->setAttribute('locale', $locale);
        }
        $this->authored($row, true);
        $row = DB::transaction(function () use ($row, $wire, $links, $serializer): Model {
            StrapiRelations::associate($row, $links);
            $row->save();
            $serializer::syncChildren($row, $wire['children']);
            StrapiRelations::link($row, $links);

            return $row;
        });

        return $this->answer($row->fresh(), links: false);
    }

    /** @return array<string, mixed> */
    private function update(array $args): array
    {
        $documentId = (string) $args['documentId'];
        $locale = $this->locale($args);
        $row = $this->version($documentId, $locale, false);
        if ($row === null) {
            if ($locale !== null && $this->exists($documentId)) {
                return $this->create($args, $documentId);
            }
            throw StrapiMcpError::notFound();
        }

        return $this->change($row, $this->data($args));
    }

    /** A single type's write: its version in the locale changed, else made. */
    private function write(array $args): array
    {
        $locale = $this->locale($args);
        $documentId = $this->query()->value('document_id');
        $row = $documentId === null ? null : $this->version((string) $documentId, $locale, false);

        return $row === null
            ? $this->create($args, $documentId === null ? null : (string) $documentId)
            : $this->change($row, $this->data($args));
    }

    /** @return array<string, mixed> */
    private function delete(array $args): array
    {
        $documentId = $this->documentId($args);
        $locale = $this->locale($args);
        $rows = $documentId === null ? collect() : $this->inLocale($this->query()->where('document_id', $documentId), $locale)->get();
        if ($rows->isEmpty()) {
            throw StrapiMcpError::notFound();
        }
        DB::transaction(fn () => $rows->each->delete());

        return ['data' => new \stdClass()];
    }

    /** @return array<string, mixed> */
    private function publish(array $args): array
    {
        $draft = $this->draftOf($args);
        $published = StrapiDocuments::publish($draft, $this->serializer());

        return $this->answer($published->fresh(), links: false);
    }

    /** @return array<string, mixed> */
    private function unpublish(array $args): array
    {
        $documentId = $this->documentId($args);
        $locale = $this->locale($args);
        $published = $documentId === null ? null : $this->version($documentId, $locale, true);
        $draft = $documentId === null ? null : $this->version($documentId, $locale, false);
        if ($published === null || $draft === null) {
            throw StrapiMcpError::notFound();
        }
        $answer = $this->answer($published, links: false);
        StrapiDocuments::unpublish($draft);
        if (($args['discardDraft'] ?? false) === true) {
            StrapiDocuments::destroy($draft);
        } else {
            // Strapi reads the unpublished version's localizations once it is gone, and finds its draft.
            $answer['data']['localizations'] = [[
                'documentId' => $documentId,
                ...($this->type['localized'] ? ['locale' => $draft->getAttribute('locale')] : []),
                'status' => 'draft',
            ]];
        }

        return $answer;
    }

    /** @return array<string, mixed> */
    private function discard(array $args): array
    {
        $draft = $this->draftOf($args);
        if ($this->version((string) $draft->getAttribute('document_id'), $this->locale($args), true) === null) {
            throw StrapiMcpError::notFound();
        }

        return $this->answer(StrapiDocuments::discard($draft, $this->serializer())->fresh(), links: false);
    }

    // ---------------------------------------------------------------------------- the documents

    /**
     * The answer for a version the document lacks: Strapi's empty data with what the document
     * has in its other locales, or not found when there is no such document at all.
     *
     * @return array<string, mixed>
     */
    private function missing(?string $documentId, ?string $locale, bool $published): array
    {
        if ($documentId === null || ! $this->exists($documentId)) {
            throw StrapiMcpError::notFound();
        }
        $others = $this->type['localized']
            ? $this->availableLocales($documentId, $locale, $published)
            : [];

        return ['data' => new \stdClass(), 'meta' => ['availableLocales' => $others, 'availableStatus' => []]];
    }

    /** @return array<string, mixed> */
    private function answer(Model $row, bool $links): array
    {
        $documentId = (string) $row->getAttribute('document_id');
        $locale = $this->type['localized'] ? $row->getAttribute('locale') : null;
        $published = $row->getAttribute('published_at') !== null;
        $availableStatus = [];
        if ($this->type['draftAndPublish']) {
            $other = $this->version($documentId, $locale, ! $published);
            if ($other !== null) {
                $availableStatus[] = $this->statusEntry($other);
            }
        }

        return [
            'data' => $this->document($row, $links),
            'meta' => [
                'availableLocales' => $this->type['localized'] ? $this->availableLocales($documentId, $locale, $published) : [],
                'availableStatus' => $availableStatus,
            ],
        ];
    }

    /**
     * One version as the Content Manager shows it.
     *
     * @return array<string, mixed>
     */
    private function document(Model $row, bool $links, bool $listed = false): array
    {
        $serializer = $this->serializer();
        $published = $row->getAttribute('published_at') !== null;
        $wire = StrapiPopulate::one($row, ['populate' => $this->type['populate'], 'status' => $published ? 'published' : 'draft'], $serializer, null);
        $document = ['id' => $row->getKey(), 'documentId' => $row->getAttribute('document_id')];
        foreach ($this->type['attributes'] as $name => $attribute) {
            if ($attribute['kind'] === 'scalar') {
                $document[$name] = array_key_exists($name, $wire) ? $wire[$name] : $this->column($row, $name);
            }
        }
        $document['createdAt'] = $wire['createdAt'] ?? null;
        $document['updatedAt'] = $wire['updatedAt'] ?? null;
        $document['publishedAt'] = $this->publishedAt($row);
        $document['locale'] = $this->type['localized'] ? $row->getAttribute('locale') : null;
        foreach ($this->type['attributes'] as $name => $attribute) {
            $document[$name] = match ($attribute['kind']) {
                'scalar' => $document[$name],
                'relation' => $links ? self::identities($attribute, $wire[$name] ?? null) : ($attribute['many'] ? [] : null),
                default => $wire[$name] ?? null,
            };
        }
        $document['createdBy'] = self::author($row, 'created_by_id', true);
        $document['updatedBy'] = self::author($row, 'updated_by_id', true);
        $document['localizations'] = $this->localizations($row);
        if ($this->type['draftAndPublish'] || $listed) {
            $document['status'] = $this->status($row);
        }

        return $document;
    }

    /** A type without draft & publish reads its publishedAt where its serializer does. */
    private function publishedAt(Model $row): ?string
    {
        $column = $this->type['draftAndPublish'] ? 'published_at' : ($this->serializer()::FIELDS['publishedAt']['column'] ?? 'published_at');

        return self::time($row->getAttribute($column));
    }

    /** to-one: the document it names, or null; to-many: the documents, in order. */
    private static function identities(array $attribute, mixed $value): mixed
    {
        $identity = function (mixed $entry) use ($attribute): ?array {
            if (! is_array($entry) || ! is_string($entry['documentId'] ?? null)) {
                return null;
            }

            return ['documentId' => $entry['documentId'], ...(($attribute['localizedTarget'] ?? false) && is_string($entry['locale'] ?? null) ? ['locale' => $entry['locale']] : [])];
        };
        if ($attribute['many']) {
            return is_array($value) && array_is_list($value) ? array_values(array_filter(array_map($identity, $value))) : [];
        }

        return $value === null ? null : $identity($value);
    }

    /** Draft, published, or modified: a draft changed since its published version was. */
    private function status(Model $row): string
    {
        if (! $this->type['draftAndPublish']) {
            return 'published';
        }
        $published = $row->getAttribute('published_at') !== null;
        $locale = $this->type['localized'] ? $row->getAttribute('locale') : null;
        $other = $this->version((string) $row->getAttribute('document_id'), $locale, ! $published);
        $draft = $published ? $other : $row;
        $publishedVersion = $published ? $row : $other;
        if ($draft === null) {
            return 'published';
        }
        if ($publishedVersion === null) {
            return 'draft';
        }

        return self::millis($draft->getAttribute('updated_at')) > self::millis($publishedVersion->getAttribute('updated_at')) ? 'modified' : 'published';
    }

    /** @return list<array<string, mixed>> */
    private function localizations(Model $row): array
    {
        if (! $this->type['localized']) {
            return [];
        }
        $published = $row->getAttribute('published_at') !== null;
        $entries = [];
        foreach ($this->otherLocales((string) $row->getAttribute('document_id'), $row->getAttribute('locale'), $published) as $other) {
            $entries[] = [
                'documentId' => $other->getAttribute('document_id'),
                'locale' => $other->getAttribute('locale'),
                ...($this->type['draftAndPublish'] ? ['status' => $this->status($other)] : []),
            ];
        }

        return $entries;
    }

    /** @return list<array<string, mixed>> */
    private function availableLocales(string $documentId, ?string $locale, bool $published): array
    {
        $entries = [];
        foreach ($this->otherLocales($documentId, $locale, $published) as $other) {
            $entry = [
                'id' => $other->getKey(),
                'documentId' => $other->getAttribute('document_id'),
                'locale' => $other->getAttribute('locale'),
                'updatedAt' => self::time($other->getAttribute('updated_at')),
                'createdAt' => self::time($other->getAttribute('created_at')),
                'publishedAt' => $this->publishedAt($other),
            ];
            foreach ($this->type['attributes'] as $name => $attribute) {
                if ($attribute['kind'] === 'scalar' && ($attribute['shared'] ?? false)) {
                    $entry[$name] = $this->column($other, $name);
                }
            }
            $entry['createdBy'] = self::author($other, 'created_by_id', true);
            $entry['updatedBy'] = self::author($other, 'updated_by_id', true);
            if ($this->type['draftAndPublish']) {
                $entry['status'] = $this->status($other);
            }
            $entries[] = $entry;
        }

        return $entries;
    }

    /**
     * Each other locale's version: the one in the same status, else its other one.
     *
     * @return list<Model>
     */
    private function otherLocales(string $documentId, ?string $locale, bool $published): array
    {
        $rows = $this->query()->where('document_id', $documentId)
            ->when($locale !== null, fn (Builder $q) => $q->where('locale', '!=', $locale))
            ->orderBy('id')->get();
        $byLocale = [];
        foreach ($rows as $row) {
            $code = (string) $row->getAttribute('locale');
            $same = ! $this->type['draftAndPublish'] || ($row->getAttribute('published_at') !== null) === $published;
            if (! isset($byLocale[$code]) || $same) {
                $byLocale[$code] ??= $row;
                if ($same) {
                    $byLocale[$code] = $row;
                }
            }
        }

        return array_values($byLocale);
    }

    /** @return array<string, mixed> the other status's version, as availableStatus lists it */
    private function statusEntry(Model $other): array
    {
        return [
            'id' => $other->getKey(),
            'documentId' => $other->getAttribute('document_id'),
            'locale' => $this->type['localized'] ? $other->getAttribute('locale') : null,
            'updatedAt' => self::time($other->getAttribute('updated_at')),
            'createdAt' => self::time($other->getAttribute('created_at')),
            'publishedAt' => $this->publishedAt($other),
            'createdBy' => self::author($other, 'created_by_id', false),
            'updatedBy' => self::author($other, 'updated_by_id', false),
        ];
    }

    /** @return array<string, mixed>|null the admin account, as Strapi populates a creator */
    private static function author(Model $row, string $column, bool $full): ?array
    {
        $id = $row->getAttribute($column);
        $admin = $id === null ? null : AdminUser::query()->find($id);
        if ($admin === null) {
            return null;
        }

        return $full
            ? ['id' => $admin->id, 'firstname' => $admin->firstname, 'lastname' => $admin->lastname, 'username' => $admin->username, 'email' => $admin->email, 'isActive' => (bool) $admin->is_active]
            : ['id' => $admin->id, 'firstname' => $admin->firstname, 'lastname' => $admin->lastname, 'email' => $admin->email];
    }

    // ------------------------------------------------------------------------------- the rows

    /** @param array<string, mixed> $data */
    private function change(Model $row, array $data): array
    {
        $serializer = $this->serializer();
        $wire = $serializer::fromWire($data);
        $links = StrapiRelations::read($data, $serializer::FIELDS, null, $this->type['localized'] ? $row->getAttribute('locale') : null);
        $row->fill($wire['columns']);
        $this->authored($row, false);
        DB::transaction(function () use ($row, $wire, $links, $serializer): void {
            StrapiRelations::associate($row, $links);
            $row->save();
            $serializer::syncChildren($row, $wire['children']);
            StrapiRelations::link($row, $links);
        });

        return $this->answer($row->fresh(), links: false);
    }

    private function draftOf(array $args): Model
    {
        $documentId = $this->documentId($args);
        $draft = $documentId === null ? null : $this->version($documentId, $this->locale($args), false);

        return $draft ?? throw StrapiMcpError::notFound();
    }

    /** The token's owner made or last changed the row, as the admin records it. */
    private function authored(Model $row, bool $creating): void
    {
        if (! method_exists($row, 'createdBy')) {
            return;
        }
        if ($creating) {
            $row->setAttribute('created_by_id', $row->getAttribute('created_by_id') ?? $this->owner->id);
        }
        $row->setAttribute('updated_by_id', $this->owner->id);
    }

    private function version(string $documentId, ?string $locale, bool $published): ?Model
    {
        return $this->versions($this->query()->where('document_id', $documentId), $locale, $published)->first();
    }

    private function versions(Builder $query, ?string $locale, bool $published): Builder
    {
        if ($this->type['draftAndPublish']) {
            $published ? $query->whereNotNull('published_at') : $query->whereNull('published_at');
        }

        return $this->inLocale($query, $locale);
    }

    private function inLocale(Builder $query, ?string $locale): Builder
    {
        return $locale === null ? $query : $query->where('locale', $locale);
    }

    private function exists(string $documentId): bool
    {
        return $this->query()->where('document_id', $documentId)->exists();
    }

    private function query(): Builder
    {
        return $this->type['model']::query();
    }

    /** @return class-string */
    private function serializer(): string
    {
        return $this->type['serializer'];
    }

    private function documentId(array $args): ?string
    {
        if ($this->type['kind'] === 'singleType') {
            $documentId = $this->query()->value('document_id');

            return $documentId === null ? null : (string) $documentId;
        }

        return (string) $args['documentId'];
    }

    /** The locale a localized type works in: the one asked for, else the default one. */
    private function locale(array $args): ?string
    {
        if (! $this->type['localized']) {
            return null;
        }

        return is_string($args['locale'] ?? null) ? $args['locale'] : StrapiLocales::default();
    }

    private function published(array $args): bool
    {
        return $this->type['draftAndPublish'] && ($args['status'] ?? 'draft') === 'published';
    }

    /** @return array<string, mixed> */
    private function data(array $args): array
    {
        return is_array($args['data'] ?? null) ? $args['data'] : [];
    }

    /** A field the wire leaves out (a private one), read from its column. */
    private function column(Model $row, string $name): mixed
    {
        $field = $this->serializer()::FIELDS[$name] ?? null;
        $column = is_array($field) ? ($field['column'] ?? null) : null;

        return $column === null ? null : $row->getAttribute($column);
    }

    private static function time(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        return \Illuminate\Support\Carbon::parse($value)->toIso8601ZuluString('millisecond');
    }

    private static function millis(mixed $value): float
    {
        return $value === null ? 0.0 : (float) \Illuminate\Support\Carbon::parse($value)->format('Uv');
    }
}
