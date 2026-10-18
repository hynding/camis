import { PHP_MARKER } from "../hooks/names";

const header = (namespace: string): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace ${namespace};\n`;

/**
 * Strapi 5's locale parameter: reads and writes go to the locale it names, the default locale
 * when it names none, and `locale=*` reads every locale. A missing locale of an existing document
 * is created by writing to it, with the fields every locale shares copied from the document (as
 * strapi-php's document service does). The canonical check is `i18n-vectors.json`.
 */
export const emitStrapiLocales = (): string =>
  header("App\\Support") +
  String.raw`
use App\Models\Locale;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Arr;

final class StrapiLocales
{
    private static ?string $default = null;

    /** The default locale's code: the locales table's, else the configured one. */
    public static function default(): string
    {
        return self::$default ??= Locale::query()->where('is_default', true)->value('code')
            ?? (string) config('camis.i18n.default_locale', 'en');
    }

    /** The locale a request names, '*' for all of them, or the default one. */
    public static function requested(array $params): string
    {
        $locale = $params['locale'] ?? null;
        if ($locale === null || $locale === '') {
            return self::default();
        }
        if (! is_string($locale)) {
            throw StrapiError::validation('Invalid locale param provided. Document locales must be strings.');
        }

        return $locale;
    }

    /** Narrows a query to the requested locale; '*' keeps them all. */
    public static function narrow(Builder $query, array $params): Builder
    {
        $locale = self::requested($params);

        return $locale === '*' ? $query : $query->where($query->qualifyColumn('locale'), $locale);
    }

    /** The one locale a write goes to. */
    public static function forWrite(array $params): string
    {
        $locale = self::requested($params);
        if ($locale === '*') {
            throw StrapiError::validation('Invalid locale param "*" provided. Document locales must be strings.');
        }

        return $locale;
    }

    /**
     * A new, unsaved locale of the document $document finds, holding the fields every locale
     * shares, copied from its published version when it has one. Null when there is no document.
     */
    public static function localization(Builder $document, string $locale): ?Model
    {
        $model = $document->getModel();
        $published = method_exists($model, 'publishedVersion')
            ? (clone $document)->whereNotNull($document->qualifyColumn('published_at'))->first()
            : null;
        $sibling = $published ?? $document->first();
        if ($sibling === null) {
            return null;
        }
        $row = $model->newInstance();
        $row->forceFill([
            ...Arr::only($sibling->getAttributes(), $sibling->sharedAcrossLocales()),
            'document_id' => $sibling->getAttribute('document_id'),
            'locale' => $locale,
        ]);

        return $row;
    }
}
`;

/**
 * The model half: each locale of a document is a row, and the fields every locale shares are
 * kept equal across the document's rows of the same status, as Strapi's i18n plugin does. A row
 * created without a locale is in the default one.
 */
export const emitHasLocale = (): string =>
  header("App\\Models\\Concerns") +
  String.raw`
use App\Support\StrapiLocales;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Arr;

trait HasLocale
{
    /** @return list<string> the columns every locale of a document shares */
    abstract public function sharedAcrossLocales(): array;

    public function initializeHasLocale(): void
    {
        $this->mergeFillable(['locale']);
    }

    protected static function bootHasLocale(): void
    {
        static::creating(function (Model $row): void {
            $row->setAttribute('locale', $row->getAttribute('locale') ?? StrapiLocales::default());
        });
        static::created(fn (Model $row) => $row->shareAcrossLocales($row->sharedAcrossLocales()));
        static::updated(fn (Model $row) => $row->shareAcrossLocales(
            array_values(array_filter($row->sharedAcrossLocales(), fn (string $column): bool => $row->wasChanged($column))),
        ));
    }

    /** Every row of the document, this one included; populate narrows it to the other locales. */
    public function localizations(): HasMany
    {
        return $this->hasMany(static::class, 'document_id', 'document_id');
    }

    /** @param list<string> $columns */
    protected function shareAcrossLocales(array $columns): void
    {
        if ($columns === []) {
            return;
        }
        $query = static::query()
            ->where('document_id', $this->getAttribute('document_id'))
            ->where('locale', '!=', $this->getAttribute('locale'));
        if (method_exists($this, 'publishedVersion')) {
            $this->getAttribute('published_at') === null ? $query->whereNull('published_at') : $query->whereNotNull('published_at');
        }
        $query->update(Arr::only($this->getAttributes(), $columns));
    }
}
`;

/** The locales Strapi's i18n plugin manages: one is the default. */
export const emitLocaleModel = (): string => `<?php

declare(strict_types=1);

namespace App\\Models;

use App\\Models\\Concerns\\HasDocumentId;
use Illuminate\\Database\\Eloquent\\Model;

class Locale extends Model
{
    use HasDocumentId;

    protected $table = 'i18n_locales';

    protected $fillable = [
        'code',
        'name',
        'is_default',
    ];

    protected function casts(): array
    {
        return [
            'is_default' => 'boolean',
        ];
    }

    /** There is one default locale: making another the default unsets it. */
    protected static function booted(): void
    {
        static::saved(function (Locale $locale): void {
            if ($locale->is_default) {
                static::query()->whereKeyNot($locale->getKey())->where('is_default', true)->update(['is_default' => false]);
            }
        });
    }
}
`;

/** GET /api/i18n/locales: Strapi answers with a bare array, not a { data } envelope. */
export const emitLocaleController = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\Locale;
use Illuminate\\Http\\JsonResponse;

class LocaleController extends Controller
{
    public function index(): JsonResponse
    {
        return response()->json(Locale::query()->orderBy('id')->get()->map(fn (Locale $l): array => [
            'id' => $l->id,
            'documentId' => $l->document_id,
            'name' => $l->name,
            'code' => $l->code,
            'createdAt' => $l->created_at?->toIso8601ZuluString('millisecond'),
            'updatedAt' => $l->updated_at?->toIso8601ZuluString('millisecond'),
            // Strapi stamps publishedAt on locales, which have no draft.
            'publishedAt' => $l->created_at?->toIso8601ZuluString('millisecond'),
            'isDefault' => $l->is_default,
        ])->all());
    }
}
`;

export const LOCALES_MIGRATION_PATH =
  "database/migrations/0001_01_02_000000_create_i18n_locales_table.php";

/** The locales table, holding the configured default locale from the start. */
export const emitLocalesMigration = (): string => `<?php

declare(strict_types=1);

use App\\Models\\Locale;
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('i18n_locales', function (Blueprint $table): void {
            $table->id();
            $table->string('document_id', 24)->unique();
            $table->string('code', 16)->unique();
            $table->string('name');
            $table->boolean('is_default')->default(false);
            $table->timestamps();
        });
        Locale::create([
            'code' => config('camis.i18n.default_locale', 'en'),
            'name' => config('camis.i18n.default_locale_name', 'English (en)'),
            'is_default' => true,
        ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('i18n_locales');
    }
};
`;
