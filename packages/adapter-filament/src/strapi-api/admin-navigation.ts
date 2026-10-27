import { PHP_MARKER } from "../hooks/names";

/**
 * The admin's menu as Strapi's: the Content Manager's types, then Settings. Filament orders groups
 * by an enum's cases and items by their sort, so the order holds whatever the files' order.
 */

export const STRAPI_NAVIGATION_PATH = "app/Filament/StrapiNavigation.php";
export const STRAPI_NAVIGATION_CLASS = "App\\Filament\\StrapiNavigation";

export type NavigationGroup = "CollectionTypes" | "SingleTypes" | "Settings";

export interface Navigation {
  group: NavigationGroup;
  label: string;
  sort: number;
}

const settings = (label: string, sort: number): Navigation => ({ group: "Settings", label, sort });

/** Strapi's Settings, in its order; the Users & Permissions plugin's entries come last. */
export const SETTINGS = {
  apiTokens: settings("API Tokens", 10),
  internationalization: settings("Internationalization", 20),
  transferTokens: settings("Transfer Tokens", 30),
  webhooks: settings("Webhooks", 40),
  dataTransfer: settings("Data transfer", 50),
  roles: settings("Roles", 60),
  usersPermissions: settings("Users & Permissions", 70),
} as const;

/** A resource's or page's navigation properties; it imports StrapiNavigation and UnitEnum. */
export const navigationProperties = (navigation: Navigation): string => `
    protected static string | UnitEnum | null $navigationGroup = StrapiNavigation::${navigation.group};

    protected static ?string $navigationLabel = '${navigation.label.replace(/'/g, "\\'")}';

    protected static ?int $navigationSort = ${navigation.sort};
`;

/** Each type's place in the Content Manager: alphabetical by display name, as Strapi lists them. */
export const contentManagerSorts = (displayNames: Iterable<string>): Map<string, number> =>
  new Map(
    [...new Set(displayNames)]
      .sort((a, b) => a.localeCompare(b, "en"))
      .map((name, index) => [name, index + 1]),
  );

export const emitStrapiNavigation = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Filament;

use Filament\\Support\\Contracts\\HasLabel;

/** The admin's menu groups, in Strapi's order. */
enum StrapiNavigation: string implements HasLabel
{
    case CollectionTypes = 'collection-types';
    case SingleTypes = 'single-types';
    case Settings = 'settings';

    public function getLabel(): string
    {
        return match ($this) {
            self::CollectionTypes => 'Collection Types',
            self::SingleTypes => 'Single Types',
            self::Settings => 'Settings',
        };
    }
}
`;

/** A list page's header, as Strapi's: its create button reads "Create new entry". */
export const CREATE_ACTION_IMPORT = "Filament\\Actions\\CreateAction";
export const createNewEntryActions = `

    protected function getHeaderActions(): array
    {
        return [
            CreateAction::make()->label('Create new entry'),
        ];
    }`;

/** users-permissions' user type, as Strapi's Content Manager names it. */
export const USER_DISPLAY_NAME = "User";
