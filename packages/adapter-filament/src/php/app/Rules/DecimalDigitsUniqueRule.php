<?php

declare(strict_types=1);

namespace App\Rules;

use App\Support\DecimalDigits;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Database\Eloquent\Model;

/**
 * A unique decimal stating its digits as the admin's form checks it, in place of Filament's
 * `->unique()`, which compares the text as typed with the stored digits: SQLite's text column
 * would take 1.5 beside a stored 1.500000 until its unique index refused the write, and MySQL
 * compares a string with a DECIMAL as two doubles. The value is compared as every filter compares
 * it (DecimalDigits::where), against the table as Laravel's unique rule reads it, ignoring the
 * record being edited.
 */
final class DecimalDigitsUniqueRule implements ValidationRule
{
    /**
     * @param class-string<Model>|null $model the form's model; without one nothing is checked, as
     *                                        Filament checks nothing
     */
    public function __construct(
        private readonly ?string $model,
        private readonly string $column,
        private readonly int $precision,
        private readonly int $scale,
        private readonly ?Model $ignored,
    ) {
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if ($this->model === null) {
            return;
        }
        $query = (new $this->model())->newQueryWithoutScopes();
        if ($this->ignored !== null) {
            $query->whereKeyNot($this->ignored->getOriginal($this->ignored->getKeyName()));
        }
        if (DecimalDigits::where($query, $this->column, '$eq', $value, $this->precision, $this->scale) && $query->exists()) {
            $fail('validation.unique')->translate();
        }
    }
}
