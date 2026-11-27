#!/usr/bin/env bash
# PHPStan over the runtime PHP the generator copies (src/strapi-api/<package>/php/<path>), checked
# where it runs: inside a Laravel app with the overlay materialized, so Eloquent, Filament and the
# generated classes it calls resolve. The Strapi storage layout's runtime (storage/php) is checked
# in a second app overlaid with that layout. The static PHP both API styles share (src/php/<path>,
# which needs only brick/math and Laravel) is emitted only for a project that uses it, so it is
# copied into the first app and checked with the Strapi API style's runtime, as are an endpoint's
# guards, emitted only for a project that declares one.
# Usage: runtime-phpstan.sh <app overlaid --style strapi> <app overlaid --style strapi --storage strapi>
set -euo pipefail
package="$(cd "$(dirname "$0")/.." && pwd)"
sources="$package/src/strapi-api"
shared="$package/src/php"
# find over a missing directory would list nothing and analyse nothing of it.
for dir in "$sources" "$shared"; do
  [ -d "$dir" ] || { echo "::error::$dir does not exist"; exit 1; }
done

# A source's path in the app is what follows its php/ directory.
in_app() { sed "s#^$sources/[^/]*/php/##"; }

analyse() {
  local app="$1" baseline="$2" failed=0 path
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
  cp "$package/$baseline" "$app/phpstan-baseline.neon"
  echo "PHPStan over ${#paths[@]} runtime files in $app"
  (cd "$app" && vendor/bin/phpstan analyse --no-progress --memory-limit=1G --error-format=raw "${paths[@]}")
}

shared_paths() { (cd "$shared" && find . -name '*.php' | sed 's#^\./##'); }

app="$(cd "$1" && pwd)"
while IFS= read -r path; do
  mkdir -p "$app/$(dirname "$path")"
  cp "$shared/$path" "$app/$path"
done < <(shared_paths)
# An endpoint's guards are emitted only for a project that declares one, which the first app's
# fixture does not, so they are copied in as the shared PHP is.
for path in app/Http/Middleware/StrapiEndpointGuard.php app/Http/Middleware/StrapiEndpointCors.php; do
  [ -f "$app/$path" ] || cp "$sources/core/php/$path" "$app/$path"
done

st=0
{
  find "$sources" -mindepth 3 -path "$sources/*/php/*" ! -path "$sources/storage/*" -name '*.php' | in_app
  shared_paths
} | sort | analyse "$app" phpstan-baseline.neon || st=1
find "$sources/storage/php" -name '*.php' | in_app | sort |
  analyse "$(cd "$2" && pwd)" phpstan-baseline.storage.neon || st=1
exit "$st"
