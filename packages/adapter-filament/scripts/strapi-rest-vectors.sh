#!/usr/bin/env bash
# Runs the Strapi REST query vectors against a running app on an empty database: seeds the rows,
# then checks every query's rows (in order), meta and error envelope. The same vectors pass against
# strapi-php, which is how they are known to be Strapi's behaviour rather than camis's.
#
# usage: strapi-rest-vectors.sh <api-base e.g. http://127.0.0.1:8765/api> [bearer-token] [vectors.json]
set -euo pipefail
BASE="${1:?usage: strapi-rest-vectors.sh <api-base> [bearer-token] [vectors.json]}"
TOKEN="${2:-}"
VECTORS="${3:-$(dirname "$0")/../src/strapi-api/__fixtures__/rest-query-vectors.json}"
PATH_="$(jq -r .path "$VECTORS")"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

AUTH=()
[[ -n "$TOKEN" ]] && AUTH=(-H "Authorization: Bearer $TOKEN")

# -g: the query strings carry literal [ ] that curl would otherwise read as URL globs.
call() { # method url [json-body] → prints the status; the body lands in $BODY
  local args=(-g -s -o "$BODY" -w '%{http_code}' -X "$1" -H 'Accept: application/json' "${AUTH[@]}")
  [[ -n "${3:-}" ]] && args+=(-H 'Content-Type: application/json' --data "$3")
  curl "${args[@]}" "$2"
}

while read -r row; do
  code="$(call POST "$BASE$PATH_" "{\"data\":$row}")"
  [[ "$code" == "200" || "$code" == "201" ]] || { echo "SEED FAIL ($code): $(cat "$BODY")" >&2; exit 1; }
done < <(jq -c '.seed[]' "$VECTORS")

failures=0
fail() { failures=$((failures + 1)); echo "FAIL $1: $2" >&2; }
component_keys="$(jq -c .componentKeys "$VECTORS")"

count="$(jq '.vectors | length' "$VECTORS")"
for i in $(seq 0 $((count - 1))); do
  v="$(jq -c ".vectors[$i]" "$VECTORS")"
  name="$(jq -r .name <<<"$v")"
  query="$(jq -r .query <<<"$v")"
  code="$(call GET "$BASE$PATH_?$query")"

  if [[ "$(jq 'has("error")' <<<"$v")" == "true" ]]; then
    want="$(jq -c '[.status, .error.name, .error.message]' <<<"$v")"
    got="$(jq -c --argjson s "$code" '[$s, .error.name, .error.message]' "$BODY" 2>/dev/null || echo "unparsable")"
    [[ "$got" == "$want" ]] || fail "$name" "want $want, got $got"
    [[ "$(jq -c .data "$BODY" 2>/dev/null)" == "null" ]] || fail "$name" "error body must carry data: null"
    if [[ "$(jq '.error | has("details")' <<<"$v")" == "true" ]]; then
      want="$(jq -cS .error.details <<<"$v")"
      got="$(jq -cS .error.details "$BODY")"
      [[ "$got" == "$want" ]] || fail "$name" "details: want $want, got $got"
    fi
    continue
  fi

  [[ "$code" == "200" ]] || { fail "$name" "status $code: $(cat "$BODY")"; continue; }
  want="$(jq -c .titles <<<"$v")"
  got="$(jq -c '[.data[].title]' "$BODY")"
  [[ "$got" == "$want" ]] || fail "$name" "rows: want $want, got $got"
  if [[ "$(jq 'has("meta")' <<<"$v")" == "true" ]]; then
    want="$(jq -cS .meta <<<"$v")"
    got="$(jq -cS .meta "$BODY")"
    [[ "$got" == "$want" ]] || fail "$name" "meta: want $want, got $got"
  fi
  if [[ "$(jq 'has("keys")' <<<"$v")" == "true" ]]; then
    want="$(jq -c '.keys | sort' <<<"$v")"
    got="$(jq -c --argjson c "$component_keys" '.data[0] | keys - $c | sort' "$BODY")"
    [[ "$got" == "$want" ]] || fail "$name" "keys: want $want, got $got"
  fi
done

# One document by its documentId: data plus an empty meta object.
call GET "$BASE$PATH_?pagination[pageSize]=1" >/dev/null
doc="$(jq -r '.data[0].documentId' "$BODY")"
[[ "${#doc}" == "24" ]] || fail "documentId" "want a 24-character documentId, got '$doc'"
code="$(call GET "$BASE$PATH_/$doc")"
[[ "$code" == "200" && "$(jq -c .meta "$BODY")" == "{}" && "$(jq -r .data.documentId "$BODY")" == "$doc" ]] \
  || fail "findOne" "status $code: $(cat "$BODY")"

# A missing document: Strapi's full error envelope.
code="$(call GET "$BASE$PATH_/nonexistentdocumentid0000")"
got="$(jq -c --argjson s "$code" '[$s, .data, .error.status, .error.name, .error.details]' "$BODY" 2>/dev/null || echo unparsable)"
[[ "$got" == '[404,null,404,"NotFoundError",{}]' ]] || fail "not found envelope" "got $got"

if [[ "$failures" -gt 0 ]]; then
  echo "REST VECTORS: $failures of $((count + 2)) failed" >&2
  exit 1
fi
echo "REST VECTORS OK ($((count + 2)) checks)"
