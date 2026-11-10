<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

final class StrapiUid
{
    /** strapi-php's slugify: transliterated, decamelized, non-alphanumerics to one dash, lowercased. */
    public static function slugify(string $value): string
    {
        $value = Str::ascii($value);
        $value = (string) preg_replace('/([a-z\d])([A-Z])/', '$1 $2', $value);
        $value = (string) preg_replace('/[^a-zA-Z\d]+/', '-', $value);
        $value = (string) preg_replace('/^-|-$/', '', (string) preg_replace('/-{2,}/', '-', $value));

        return strtolower($value);
    }

    /** @param class-string<Model> $model */
    public static function generate(string $model, string $column, mixed $target, ?string $locale, string $fallback): string
    {
        $source = is_scalar($target) && (string) $target !== '' ? (string) $target : $fallback;

        return self::unique($model, $column, self::slugify($source), $locale);
    }

    /** @param class-string<Model> $model */
    public static function unique(string $model, string $column, string $value, ?string $locale): string
    {
        $taken = self::drafts($model, $locale)
            ->where($column, 'like', addcslashes($value, '%_\\') . '%')
            ->pluck($column)
            ->all();
        if (! in_array($value, $taken, true)) {
            return $value;
        }
        $i = 1;
        while (in_array("{$value}-{$i}", $taken, true)) {
            $i++;
        }

        return "{$value}-{$i}";
    }

    /** Whether no other document's draft in the locale has the value. */
    public static function available(string $model, string $column, ?string $value, ?string $locale, ?Model $record): bool
    {
        if ($value === null || $value === '') {
            return true;
        }
        $query = self::drafts($model, $locale)->where($column, $value);
        if ($record !== null) {
            $query->where('document_id', '!=', $record->getAttribute('document_id'));
        }

        return $query->doesntExist();
    }

    /** A validation rule refusing a value another document's draft in the locale has. */
    public static function rule(string $model, string $column, ?string $locale, ?Model $record): \Closure
    {
        return function (string $attribute, mixed $value, \Closure $fail) use ($model, $column, $locale, $record): void {
            if (! self::available($model, $column, is_scalar($value) ? (string) $value : null, $locale, $record)) {
                $fail('This value is already taken.');
            }
        };
    }

    /** @param class-string<Model> $model */
    private static function drafts(string $model, ?string $locale): Builder
    {
        $query = $model::query();
        if (method_exists($model, 'publishedVersion')) {
            $query->whereNull('published_at');
        }
        if ($locale !== null && method_exists($model, 'localizations')) {
            $query->where('locale', $locale);
        }

        return $query;
    }
}
