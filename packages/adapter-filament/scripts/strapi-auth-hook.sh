#!/usr/bin/env bash
# The camis side of strapi-auth-vectors.mjs --hook, run from the generated app's directory: reads
# what only the database knows and changes what only an administrator can, through artisan tinker.
# usage: strapi-auth-hook.sh lookup reset|confirmation <username> | lookup role <name>
#        | settings <json> | block <username> | allow create|update|destroy | role <name> <action>...
set -euo pipefail
php_string() { printf "'%s'" "$(printf '%s' "$1" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")"; }
case "$1" in
  lookup)
    case "$2" in
      reset) code="echo App\\Models\\User::where('username', $(php_string "$3"))->value('reset_password_token');" ;;
      confirmation) code="echo App\\Models\\User::where('username', $(php_string "$3"))->value('confirmation_token');" ;;
      role) code="echo Spatie\\Permission\\Models\\Role::findByName($(php_string "$3"))->getKey();" ;;
    esac ;;
  settings) code="App\\Support\\StrapiSettings::merge('users-permissions.advanced', json_decode($(php_string "$2"), true));" ;;
  block) code="App\\Models\\User::where('username', $(php_string "$2"))->update(['blocked' => true]);" ;;
  allow)
    action="$2"; [[ "$action" == destroy ]] && action=delete
    code="Spatie\\Permission\\Models\\Role::findByName('authenticated')->givePermissionTo(Spatie\\Permission\\Models\\Permission::findOrCreate('user.$action'));" ;;
  # strapi-php's roles start empty; camis's are seeded from the IR, which already grants these.
  role) exit 0 ;;
  *) echo "unknown hook $1" >&2; exit 1 ;;
esac
php artisan tinker --execute="$code"
