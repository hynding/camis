import { runtimePhp } from "../runtime-php";

/**
 * Strapi 5's locale parameter: reads and writes go to the locale it names, the default locale
 * when it names none, and `locale=*` reads every locale. A missing locale of an existing document
 * is created by writing to it, with the fields every locale shares copied from the document (as
 * strapi-php's document service does). The canonical check is `i18n-vectors.json`.
 */
export const emitStrapiLocales = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiLocales.php", import.meta.url));

/**
 * The model half: each locale of a document is a row, and the fields every locale shares are
 * kept equal across the document's rows of the same status, as Strapi's i18n plugin does. A row
 * created without a locale is in the default one.
 */
export const emitHasLocale = (): string =>
  runtimePhp(new URL("./php/app/Models/Concerns/HasLocale.php", import.meta.url));

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
export const emitLocaleController = (): string =>
  runtimePhp(new URL("./php/app/Http/Controllers/Api/LocaleController.php", import.meta.url));

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
