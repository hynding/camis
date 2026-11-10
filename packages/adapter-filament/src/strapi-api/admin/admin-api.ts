import type { GeneratedFile } from "@camis/adapter-kernel";
import { runtimePhp } from "../../runtime-php";
import { emitAdminUserResourceFiles } from "./admin-users";

/**
 * Strapi's admin accounts on the Strapi API style: the part of its admin API a client signs in
 * through (/admin/init, /admin/login, /admin/register-admin, /admin/users/me, /admin/api-tokens),
 * Settings › Admin users, and `php artisan strapi:import-admins`, which brings a Strapi project's
 * admin accounts over from its database. The accounts themselves are every Filament app's
 * (admin-access.ts); this is what a project with roles adds on the Strapi API style.
 */

export const ADMIN_ROUTES_PATH = "routes/admin.php";

/** Strapi's own key: a project moving off Strapi keeps its ADMIN_JWT_SECRET. */
export const adminAuthConfigKeys = (): string => `

    // What an admin's access token is signed with (Strapi's admin.auth.secret); unset, the app key.
    'admin_auth' => [
        'secret' => env('ADMIN_JWT_SECRET'),
    ],`;

const RUNTIME_FILES = [
  ADMIN_ROUTES_PATH,
  "app/Support/StrapiAdminAuth.php",
  "app/Http/Controllers/Admin/StrapiAdminController.php",
  "app/Http/Controllers/Admin/StrapiAdminApiTokens.php",
  "app/Support/StrapiAdminImport.php",
  "app/Console/Commands/StrapiImportAdmins.php",
];

export const strapiAdminFiles = (): GeneratedFile[] => [
  ...RUNTIME_FILES.map((path) => ({
    path,
    content: runtimePhp(new URL(`./php/${path}`, import.meta.url)),
  })),
  ...emitAdminUserResourceFiles(),
];
