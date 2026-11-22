<?php

declare(strict_types=1);

namespace App\Rules;

use App\Support\DecimalDigits;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * A decimal stating its digits as the admin's form takes it: text DecimalDigits reads as a decimal
 * that fits, never a float, so the form refuses what its model's cast would, with a message.
 */
final class DecimalDigitsRule implements ValidationRule
{
    public function __construct(private readonly int $precision, private readonly int $scale)
    {
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (DecimalDigits::canonical($value, $this->precision, $this->scale) === null) {
            $fail(DecimalDigits::refusal(':attribute', $this->precision, $this->scale));
        }
    }
}
