<?php

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Http\Middleware\AdminLocale;
use Filament\Auth\Pages\EditProfile;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Schemas\Schema;

/**
 * Strapi's profile page: an admin account's names, email and password, and the interface language
 * the admin speaks to it, among the admin's locales.
 */
class AdminProfile extends EditProfile
{
    public function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('firstname')->required()->maxLength(255)->autofocus(),
            TextInput::make('lastname')->maxLength(255),
            TextInput::make('username')->maxLength(255),
            $this->getEmailFormComponent(),
            $this->getPasswordFormComponent(),
            $this->getPasswordConfirmationFormComponent(),
            $this->getCurrentPasswordFormComponent(),
            Select::make('prefered_language')
                ->label('Interface language')
                ->placeholder('As the app is set')
                ->options(fn (): array => self::languages())
                ->in(AdminLocale::locales()),
        ]);
    }

    /** @return array<string, string> each locale by its own name for itself ("Français") */
    private static function languages(): array
    {
        $languages = [];
        foreach (AdminLocale::locales() as $locale) {
            $name = class_exists(\Locale::class) ? \Locale::getDisplayName($locale, $locale) : $locale;
            $languages[$locale] = mb_convert_case($name, MB_CASE_TITLE, 'UTF-8');
        }

        return $languages;
    }
}
