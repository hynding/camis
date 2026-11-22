<?php

declare(strict_types=1);

namespace App\Casts;

use App\Support\DecimalDigits;
use Illuminate\Contracts\Database\Eloquent\CastsAttributes;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Validation\ValidationException;

/**
 * A decimal stating its digits, as `DecimalDigitsCast::class.':precision,scale'`: whatever writes
 * it through Eloquent (an API, the admin, a seeder) stores it as DecimalDigits keeps it, so SQLite's
 * text column holds what MySQL and PostgreSQL would, and a value that is not a decimal that fits is
 * refused before it is written. It reads as that same string, never through a float.
 *
 * @implements CastsAttributes<string|null, mixed>
 */
final class DecimalDigitsCast implements CastsAttributes
{
    private readonly int $precision;

    private readonly int $scale;

    public function __construct(string $precision, string $scale)
    {
        $this->precision = (int) $precision;
        $this->scale = (int) $scale;
    }

    /** A stored value DecimalDigits cannot read is answered as it is, so one row cannot break a list. */
    public function get(Model $model, string $key, mixed $value, array $attributes): mixed
    {
        if ($value === null) {
            return null;
        }

        return DecimalDigits::canonical($value, $this->precision, $this->scale) ?? $value;
    }

    public function set(Model $model, string $key, mixed $value, array $attributes): ?string
    {
        if ($value === null) {
            return null;
        }

        return DecimalDigits::canonical($value, $this->precision, $this->scale)
            ?? throw ValidationException::withMessages([$key => DecimalDigits::refusal($key, $this->precision, $this->scale)]);
    }
}
