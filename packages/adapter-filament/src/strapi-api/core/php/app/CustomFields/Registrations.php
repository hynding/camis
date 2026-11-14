<?php

declare(strict_types=1);

namespace App\CustomFields;

use App\Support\CustomFields;

/**
 * The project's custom fields, as a Strapi plugin registers its own with strapi.customFields.register
 * (on the server) and app.customFields.register (in the admin). Hand-written: camis seeds this file
 * once and never overwrites it. A field whose editor is a registered uid is edited with its input,
 * and the Content-Type Builder offers each one beside Strapi's own fields.
 */
final class Registrations
{
    public function __invoke(): void
    {
        // CustomFields::register([
        //     'name' => 'rating',
        //     'plugin' => 'stars',          // its uid is then plugin::stars.rating, else global::rating
        //     'type' => 'integer',          // the Strapi type it stores
        //     'inputSize' => ['default' => 4, 'isResizable' => true],
        //     'label' => 'Rating',
        //     'description' => 'From one star to five',
        //     'icon' => 'heroicon-o-star',
        //     'input' => fn (string $name, array $options) => \Filament\Forms\Components\Select::make($name)
        //         ->options(array_combine(range(1, 5), range(1, 5))),
        //     'options' => fn (): array => [\Filament\Forms\Components\TextInput::make('max')->numeric()],
        // ]);
    }
}
