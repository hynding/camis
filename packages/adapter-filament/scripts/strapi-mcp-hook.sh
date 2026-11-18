#!/usr/bin/env bash
# The camis side of strapi-mcp-vectors.mjs --hook, run from the generated app's directory: what
# strapi-php's admin does through a route camis serves only as a Filament page.
# usage: strapi-mcp-hook.sh admin <email> <password> <firstname> <lastname> | locale <code>
#        | file <name> <text>
set -euo pipefail
case "$1" in
  # The IR names no admin role, so the account Strapi's first admin is gets one holding every grant.
  admin) php artisan tinker --execute="\$role = Spatie\\Permission\\Models\\Role::findOrCreate('super-admin'); foreach ([...array_keys(App\\Support\\StrapiAdminPermissions::PERMISSIONS), 'user.update'] as \$p) { Spatie\\Permission\\Models\\Permission::findOrCreate(\$p); } \$role->syncPermissions(Spatie\\Permission\\Models\\Permission::all()); App\\Models\\AdminUser::query()->firstOrCreate(['email' => '$2'], ['password' => '$3', 'firstname' => '$4', 'lastname' => '$5', 'is_active' => true])->assignRole(\$role);" ;;
  locale) php artisan tinker --execute="App\\Models\\Locale::query()->firstOrCreate(['code' => '$2'], ['name' => 'French ($2)', 'is_default' => false]);" ;;
  # A text file, stored as the Media Library stores an upload.
  file)
    tmp="$(mktemp)"
    printf '%s' "$3" > "$tmp"
    php artisan tinker --execute="App\\Support\\StrapiUpload::storePath('$tmp', '$2', []);"
    rm -f "$tmp" ;;
  *) echo "unknown hook $1" >&2; exit 1 ;;
esac
