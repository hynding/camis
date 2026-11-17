import type { GeneratedFile } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import type { Action } from "@camis/permissions";
import { strapiNames } from "@camis/strapi-schema";
import { PHP_MARKER } from "../../hooks/names";
import { permissionKey } from "../../permissions/keys";
import { phpSingleQuoted } from "../../php-literal";
import { runtimePhp } from "../../runtime-php";
import { USER_DISPLAY_NAME } from "./admin-navigation";
import { contentTypeUid } from "../users-permissions/strapi-actions";

/**
 * Strapi 5's admin tokens (`kind: 'admin'`): a key that acts in the admin as the admin account that
 * made it, with only the admin permissions it was given and never more than its owner holds. They
 * share the API tokens' table, are managed on Settings › Admin Tokens and through Strapi's
 * /admin/admin-tokens, and sign in clients of the MCP server.
 */

export const ADMIN_TOKENS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000008_add_admin_tokens_to_strapi_api_tokens_table.php";
export const STRAPI_ADMIN_PERMISSIONS_PATH = "app/Support/StrapiAdminPermissions.php";

export interface AdminPermissionsInput {
  emitted: ContentType[];
  versioned: ReadonlySet<string>;
  /** The builtin file type's name, whose grants are the media library's upload actions. */
  fileType: string | undefined;
  /** The builtin user type's name, users-permissions' own content type. */
  userType: string | undefined;
}

const EXPLORER = "plugin::content-manager.explorer.";
const CRUD: Action[] = ["create", "read", "update", "delete"];

// The media library's admin actions take no subject; deleting an asset is part of updating it.
const FILE_ACTIONS: [Action, string][] = [
  ["create", "plugin::upload.assets.create"],
  ["read", "plugin::upload.read"],
  ["update", "plugin::upload.assets.update"],
  ["delete", "plugin::upload.assets.update"],
];

interface Section {
  subject: string;
  label: string;
  permissions: [key: string, action: string, subject: string | null][];
}

const sections = (input: AdminPermissionsInput): Section[] => {
  const types: Section[] = input.emitted.map((ct) => {
    const uid = contentTypeUid(ct);
    const actions = input.versioned.has(ct.name) ? [...CRUD, "publish" as const] : CRUD;
    return {
      subject: uid,
      label: strapiNames(ct).displayName,
      permissions: actions.map((a) => [permissionKey(ct.name, a), `${EXPLORER}${a}`, uid]),
    };
  });
  if (input.userType !== undefined) {
    const uid = "plugin::users-permissions.user";
    const user = input.userType;
    types.push({
      subject: uid,
      label: USER_DISPLAY_NAME,
      permissions: CRUD.map((a) => [permissionKey(user, a), `${EXPLORER}${a}`, uid]),
    });
  }
  types.sort((a, b) => a.label.localeCompare(b.label, "en"));
  if (input.fileType !== undefined) {
    const file = input.fileType;
    types.push({
      subject: "plugin::upload",
      label: "Media Library",
      permissions: FILE_ACTIONS.map(([a, action]) => [permissionKey(file, a), action, null]),
    });
  }
  return types;
};

const q = phpSingleQuoted;

/** Each camis permission as Strapi's admin names it, and the sections the Admin Tokens page shows. */
export const emitStrapiAdminPermissions = (input: AdminPermissionsInput): string => {
  const all = sections(input);
  const permissions = all
    .flatMap((s) => s.permissions)
    .map(
      ([key, action, subject]) =>
        `        ${q(key)} => [${q(action)}, ${subject === null ? "null" : q(subject)}],`,
    )
    .join("\n");
  const sectionLines = all
    .map((s) => `        ${q(s.label)} => [${s.permissions.map(([key]) => q(key)).join(", ")}],`)
    .join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

/**
 * The admin permissions an admin token can be given, as Strapi's admin names them: a content
 * type's content-manager actions on its uid, the media library's upload actions on no subject.
 */
final class StrapiAdminPermissions
{
    /** A camis permission → Strapi's action and subject. */
    public const PERMISSIONS = [
${permissions}
    ];

    /** The Admin Tokens page's sections, in the Roles page's order: a label → its permissions. */
    public const SECTIONS = [
${sectionLines}
    ];

    /**
     * Strapi's permission rows for camis permissions; two that are one Strapi action are one row.
     *
     * @param  list<string>  $keys
     * @return list<array{action: string, actionParameters: object, subject: string|null, properties: object, conditions: list<never>}>
     */
    public static function toStrapi(array $keys): array
    {
        $rows = [];
        foreach ($keys as $key) {
            [$action, $subject] = self::PERMISSIONS[$key] ?? [null, null];
            if ($action !== null) {
                $rows["{$action}|{$subject}"] = ['action' => $action, 'actionParameters' => new \\stdClass(), 'subject' => $subject, 'properties' => new \\stdClass(), 'conditions' => []];
            }
        }

        return array_values($rows);
    }

    /**
     * The camis permissions Strapi's permission rows stand for; a row this app has no permission
     * for stands for none.
     *
     * @return list<string>
     */
    public static function fromStrapi(mixed $rows): array
    {
        $keys = [];
        foreach (is_array($rows) ? $rows : [] as $row) {
            $action = is_array($row) ? ($row['action'] ?? null) : null;
            $subject = is_array($row) ? ($row['subject'] ?? null) : null;
            foreach (self::PERMISSIONS as $key => [$its, $on]) {
                if ($its === $action && $on === $subject) {
                    $keys[] = $key;
                }
            }
        }

        return array_values(array_unique($keys));
    }

    /** "Create", "Read", …: the action a permission's key ends in, as the page labels it. */
    public static function label(string $key): string
    {
        return ucfirst(substr($key, (int) strrpos($key, '.') + 1));
    }
}
`;
};

const adminPhp = (path: string): string => runtimePhp(new URL(`./php/${path}`, import.meta.url));

const RUNTIME_FILES = [
  ADMIN_TOKENS_MIGRATION_PATH,
  "app/Models/StrapiAdminToken.php",
  "app/Support/StrapiAdminTokens.php",
  "app/Http/Controllers/Admin/StrapiAdminTokensController.php",
  "app/Filament/Resources/AdminTokens/AdminTokenResource.php",
  "app/Filament/Resources/AdminTokens/Pages/ListAdminTokens.php",
  "app/Filament/Resources/AdminTokens/Pages/CreateAdminToken.php",
  "app/Filament/Resources/AdminTokens/Pages/EditAdminToken.php",
];

export const adminTokenFiles = (input: AdminPermissionsInput): GeneratedFile[] => [
  { path: STRAPI_ADMIN_PERMISSIONS_PATH, content: emitStrapiAdminPermissions(input) },
  ...RUNTIME_FILES.map((path) => ({ path, content: adminPhp(path) })),
];
