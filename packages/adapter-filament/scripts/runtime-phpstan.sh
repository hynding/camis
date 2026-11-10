#!/usr/bin/env bash
# PHPStan over the runtime PHP the generator copies (src/strapi-api/<package>/php/<path>), checked
# where it runs: inside a Laravel app with the overlay materialized, so Eloquent, Filament and the
# generated classes it calls resolve. The Strapi storage layout's runtime (storage/php) is checked
# in a second app overlaid with that layout.
# Usage: runtime-phpstan.sh <app overlaid --style strapi> <app overlaid --style strapi --storage strapi>
set -euo pipefail
package="$(cd "$(dirname "$0")/.." && pwd)"
sources="$package/src/strapi-api"

# A source's path in the app is what follows its php/ directory.
in_app() { sed "s#^$sources/[^/]*/php/##"; }

analyse() {
  local app="$1" failed=0 path
  local -a paths=()
  while IFS= read -r path; do
    if [ -f "$app/$path" ]; then
      paths+=("$path")
    else
      echo "::error::$path was not generated into $app"
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] || return 1
  cp "$package/phpstan.neon" "$app/phpstan.neon"
  echo "PHPStan over ${#paths[@]} runtime files in $app"
  (cd "$app" && vendor/bin/phpstan analyse --no-progress --memory-limit=1G --error-format=github "${paths[@]}")
}

st=0
find "$sources" -mindepth 3 -path "$sources/*/php/*" ! -path "$sources/storage/*" -name '*.php' |
  in_app | sort | analyse "$(cd "$1" && pwd)" || st=1
find "$sources/storage/php" -name '*.php' | in_app | sort | analyse "$(cd "$2" && pwd)" || st=1
exit "$st"
