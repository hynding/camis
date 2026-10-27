import { formatExpression, type Expression } from "@camis/expr";
import type { Role } from "@camis/permissions";
import { strapiNames } from "@camis/strapi-schema";
import { PHP_MARKER } from "../hooks/names";
import { permissionKey } from "../permissions/keys";
import { phpSingleQuoted } from "../php-literal";
import { navigationProperties, SETTINGS, USER_DISPLAY_NAME } from "./admin-navigation";
import { contentTypeUid, strapiActions, type StrapiActionsInput } from "./strapi-actions";

/**
 * Strapi's Settings › Users & Permissions › Roles, as a page that shows each role's actions. The
 * roles are the IR's, so the page shows what the IR grants (and its conditions, which Strapi's
 * checkboxes cannot hold) rather than editing it.
 */

export const STRAPI_ROLES_PATH = "app/Support/StrapiRoles.php";

export interface RolesAdminInput extends StrapiActionsInput {
  roles: Role[];
  /** Draft-and-publish types, whose publish grant the page shows beside Strapi's actions. */
  versioned: ReadonlySet<string>;
}

/** Strapi's own descriptions of the two roles every project has. */
const STRAPI_DESCRIPTIONS: Record<string, string> = {
  authenticated: "Default role given to authenticated user.",
  public: "Default role given to unauthenticated user.",
};

interface Section {
  uid: string;
  label: string;
  actions: Map<string, string[]>;
}

/** Strapi's Roles page sections: each uid's actions, and the permissions that hold each one. */
const sections = (input: RolesAdminInput): Section[] => {
  const labels = new Map<string, string>([
    ...input.emitted.map((ct): [string, string] => [
      contentTypeUid(ct),
      strapiNames(ct).displayName,
    ]),
    ["plugin::upload.content-api", "Upload"],
    ["plugin::users-permissions.user", USER_DISPLAY_NAME],
  ]);
  const byUid = new Map<string, Section>();
  for (const [key, actions] of Object.entries(strapiActions(input))) {
    for (const qualified of actions) {
      const at = qualified.lastIndexOf(".");
      const uid = qualified.slice(0, at);
      const section = byUid.get(uid) ?? { uid, label: labels.get(uid) ?? uid, actions: new Map() };
      byUid.set(uid, section);
      const action = qualified.slice(at + 1);
      section.actions.set(action, [...(section.actions.get(action) ?? []), key]);
    }
  }
  for (const ct of input.emitted.filter((ct) => input.versioned.has(ct.name))) {
    byUid.get(contentTypeUid(ct))?.actions.set("publish", [permissionKey(ct.name, "publish")]);
  }
  return [...byUid.values()].sort((a, b) => a.label.localeCompare(b.label, "en"));
};

/** Each role's conditions by permission, joined as alternatives where two grants hold one. */
const conditions = (roles: Role[]): Map<string, Map<string, string>> => {
  const out = new Map<string, Map<string, string>>();
  for (const role of [...roles].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const byKey = new Map<string, Expression[]>();
    for (const grant of role.grants) {
      if (grant.condition === undefined) continue;
      for (const action of grant.actions) {
        const key = permissionKey(grant.contentType, action);
        byKey.set(key, [...(byKey.get(key) ?? []), grant.condition]);
      }
    }
    if (byKey.size === 0) continue;
    out.set(
      role.name,
      new Map(
        [...byKey]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, conditions]) => [
            key,
            formatExpression(
              conditions.length === 1 ? conditions[0]! : { kind: "or", args: conditions },
            ),
          ]),
      ),
    );
  }
  return out;
};

const q = phpSingleQuoted;

export const emitStrapiRoles = (input: RolesAdminInput): string => {
  const descriptions = new Map(Object.entries(STRAPI_DESCRIPTIONS));
  for (const role of input.roles) {
    if (role.description !== undefined) descriptions.set(role.name, role.description);
  }
  const descriptionLines = [...descriptions]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([name, text]) => `        ${q(name)} => ${q(text)},`)
    .join("\n");
  const sectionLines = sections(input)
    .map(
      (s) => `        ${q(s.uid)} => [
            'label' => ${q(s.label)},
            'actions' => [
${[...s.actions]
  .map(([action, keys]) => `                ${q(action)} => [${keys.map(q).join(", ")}],`)
  .join("\n")}
            ],
        ],`,
    )
    .join("\n");
  const conditionLines = [...conditions(input.roles)]
    .map(
      ([role, byKey]) => `        ${q(role)} => [
${[...byKey].map(([key, text]) => `            ${q(key)} => ${q(text)},`).join("\n")}
        ],`,
    )
    .join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use Spatie\\Permission\\Models\\Role;

/** What Strapi's Roles page shows of a role, read from the permissions the IR's grants seeded. */
final class StrapiRoles
{
    /** A role's description: the IR's, else Strapi's for the roles every project has. */
    public const DESCRIPTIONS = [
${descriptionLines}
    ];

    /** Each section of the page: a uid's actions, and the permissions that hold each one. */
    public const SECTIONS = [
${sectionLines}
    ];

    /** The IR's condition on a role's permission, which a checkbox cannot show. */
    public const CONDITIONS = [
${conditionLines}
    ];

    public static function description(Role $role): string
    {
        return self::DESCRIPTIONS[$role->name] ?? '';
    }

    /** @return list<string> The actions of a section the role holds. */
    public static function held(Role $role, string $uid): array
    {
        $names = $role->permissions->pluck('name')->all();
        $held = [];
        foreach (self::SECTIONS[$uid]['actions'] ?? [] as $action => $keys) {
            if (array_intersect($keys, $names) !== []) {
                $held[] = $action;
            }
        }

        return $held;
    }

    /** @return list<string> "find, findOne: <condition>", for each condition on a section's actions. */
    public static function conditions(Role $role, string $uid): array
    {
        $byCondition = [];
        foreach (self::SECTIONS[$uid]['actions'] ?? [] as $action => $keys) {
            foreach ($keys as $key) {
                $condition = self::CONDITIONS[$role->name][$key] ?? null;
                if ($condition !== null && ! in_array($action, $byCondition[$condition] ?? [], true)) {
                    $byCondition[$condition][] = $action;
                }
            }
        }

        return array_map(fn (string $condition, array $actions): string => implode(', ', $actions).': '.$condition, array_keys($byCondition), $byCondition);
    }
}
`;
};

const page = (cls: string, base: string, body = ""): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\Roles\\Pages;

use App\\Filament\\Resources\\Roles\\RoleResource;
use Filament\\Resources\\Pages\\${base};

class ${cls} extends ${base}
{
    protected static string $resource = RoleResource::class;${body}
}
`;

/** The Roles page: Strapi's list of roles, and each role's actions as its edit page lays them out. */
export const emitRoleResourceFiles = (): { path: string; content: string }[] => [
  {
    path: "app/Filament/Resources/Roles/RoleResource.php",
    content: `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\Roles;

use App\\Filament\\Resources\\Roles\\Pages\\ListRoles;
use App\\Filament\\Resources\\Roles\\Pages\\ViewRole;
use App\\Filament\\StrapiNavigation;
use App\\Support\\StrapiRoles;
use BackedEnum;
use Filament\\Forms\\Components\\CheckboxList;
use Filament\\Forms\\Components\\Placeholder;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Components\\Section;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;
use Illuminate\\Database\\Eloquent\\Model;
use Spatie\\Permission\\Models\\Role;
use UnitEnum;

class RoleResource extends Resource
{
    protected static ?string $model = Role::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-shield-check';
${navigationProperties(SETTINGS.roles)}
    public static function form(Schema $schema): Schema
    {
        $sections = [];
        foreach (StrapiRoles::SECTIONS as $uid => $section) {
            $sections[] = Section::make($section['label'])->collapsible()->schema([
                CheckboxList::make(md5($uid))->hiddenLabel()
                    ->options(array_combine(array_keys($section['actions']), array_keys($section['actions'])))
                    ->formatStateUsing(fn (Role $record): array => StrapiRoles::held($record, $uid))
                    ->columns(5)
                    ->dehydrated(false),
                Placeholder::make(md5($uid).'_conditions')->label('Conditions')
                    ->content(fn (Role $record): string => implode('; ', StrapiRoles::conditions($record, $uid)))
                    ->visible(fn (Role $record): bool => StrapiRoles::conditions($record, $uid) !== []),
            ]);
        }

        return $schema->components([
            TextInput::make('name'),
            Placeholder::make('description')->content(fn (Role $record): string => StrapiRoles::description($record)),
            Section::make('Permissions')
                ->description('This project\\'s schema grants these. Change a role there and rebuild to change them here.')
                ->schema($sections),
        ])->columns(1);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('name')->searchable()->sortable(),
            TextColumn::make('description')->state(fn (Role $record): string => StrapiRoles::description($record)),
            TextColumn::make('users_count')->label('Users')->counts('users'),
        ])->defaultSort('name');
    }

    public static function canViewAny(): bool
    {
        return auth()->user()?->can('user.update') ?? false;
    }

    public static function canView(Model $record): bool
    {
        return static::canViewAny();
    }

    public static function canCreate(): bool
    {
        return false;
    }

    public static function canEdit(Model $record): bool
    {
        return false;
    }

    public static function canDelete(Model $record): bool
    {
        return false;
    }

    public static function getPages(): array
    {
        return [
            'index' => ListRoles::route('/'),
            'view' => ViewRole::route('/{record}'),
        ];
    }
}
`,
  },
  {
    path: "app/Filament/Resources/Roles/Pages/ListRoles.php",
    content: page("ListRoles", "ListRecords"),
  },
  {
    path: "app/Filament/Resources/Roles/Pages/ViewRole.php",
    content: page("ViewRole", "ViewRecord"),
  },
];
