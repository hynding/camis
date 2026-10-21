#!/usr/bin/env bash
# The camis side of strapi-auth-vectors.mjs --hook, run from the generated app's directory: reads
# what only the database knows and changes what only an administrator can, through artisan tinker.
# usage: strapi-auth-hook.sh lookup reset|confirmation <username> | lookup role <name>
#        | settings <json> | provider <name> <json> | block <username> | allow create|update|destroy | role <name> <action>...
#        | token <name> <type> <action>... | expire|revoke|regenerate <name>
#        | webhook <name> <url> <headers-json> <event>... | webhook-disable <name>
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
  provider) code="App\\Support\\StrapiProviders::configure($(php_string "$2"), json_decode($(php_string "$3"), true));" ;;
  token)
    actions=""; for a in "${@:4}"; do actions+="$(php_string "$a"), "; done
    code="echo App\\Support\\StrapiApiTokens::create(['name' => $(php_string "$2"), 'type' => $(php_string "$3"), 'permissions' => [$actions]])['accessKey'];" ;;
  expire) code="App\\Models\\StrapiApiToken::where('name', $(php_string "$2"))->update(['expires_at' => now()->subMinute()]);" ;;
  revoke) code="App\\Models\\StrapiApiToken::where('name', $(php_string "$2"))->delete();" ;;
  regenerate) code="echo App\\Support\\StrapiApiTokens::regenerate(App\\Models\\StrapiApiToken::where('name', $(php_string "$2"))->sole());" ;;
  webhook)
    events=""; for e in "${@:5}"; do events+="$(php_string "$e"), "; done
    code="App\\Models\\StrapiWebhook::create(['name' => $(php_string "$2"), 'url' => $(php_string "$3"), 'headers' => json_decode($(php_string "$4"), true), 'events' => [$events], 'enabled' => true]);" ;;
  webhook-disable) code="App\\Models\\StrapiWebhook::where('name', $(php_string "$2"))->update(['enabled' => false]);" ;;
  block) code="App\\Models\\User::where('username', $(php_string "$2"))->update(['blocked' => true]);" ;;
  allow)
    action="$2"; [[ "$action" == destroy ]] && action=delete
    code="Spatie\\Permission\\Models\\Role::findByName('authenticated')->givePermissionTo(Spatie\\Permission\\Models\\Permission::findOrCreate('user.$action'));" ;;
  # strapi-php's roles start empty; camis's are seeded from the IR, which already grants these.
  role) exit 0 ;;
  *) echo "unknown hook $1" >&2; exit 1 ;;
esac
php artisan tinker --execute="$code"
