#!/usr/bin/env bash
# HTTP round trip against a running strapi-style app: register → login → CRUD/upsert → cross-owner 404.
set -euo pipefail
BASE="${1:?usage: strapi-api-smoke.sh <base-url e.g. http://127.0.0.1:8765/api>}"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
req() { # method path token body → prints "<status>\n<body>"
  local m="$1" p="$2" t="$3" b="${4:-}"
  local args=(-s -o /tmp/body -w '%{http_code}' -X "$m" -H 'Accept: application/json' -H 'Content-Type: application/json')
  [[ -n "$t" ]] && args+=(-H "Authorization: Bearer $t")
  [[ -n "$b" ]] && args+=(--data "$b")
  curl "${args[@]}" "$BASE$p"; echo; cat /tmp/body; echo
}
status() { sed -n 1p; }
body()   { sed -n 2p; }

[[ "$(req GET /_health '' | status)" == "204" ]] || fail "health"

A=$(req POST /auth/local/register '' '{"username":"alice","email":"alice@example.test","password":"secret1"}')
[[ "$(echo "$A" | status)" == "200" ]] || fail "register alice: $A"
TA=$(echo "$A" | body | jq -r .jwt); [[ -n "$TA" && "$TA" != "null" ]] || fail "no jwt"

L=$(req POST /auth/local '' '{"identifier":"alice","password":"secret1"}')
[[ "$(echo "$L" | status)" == "200" ]] || fail "login by username: $L"
[[ "$(req GET /users/me "$TA" | body | jq -r .username)" == "alice" ]] || fail "users/me"

BAD=$(req POST /auth/local '' '{"identifier":"alice","password":"wrong"}')
[[ "$(echo "$BAD" | status)" == "400" && "$(echo "$BAD" | body | jq -r .error.message)" != "null" ]] || fail "bad login shape: $BAD"

C=$(req POST /notes "$TA" '{"data":{"recordId":"n1","text":"hello","occurredAt":"2026-09-08T10:00:00.000Z","tags":["a"]}}')
[[ "$(echo "$C" | status)" == "201" ]] || fail "create: $C"
[[ "$(echo "$C" | body | jq -r .data.recordId)" == "n1" ]] || fail "create envelope: $C"
[[ "$(echo "$C" | body | jq 'has("data") and (.data|has("owner_id")|not) and (.data|has("record_id")|not)')" == "true" ]] || fail "wire keys: $C"

# Missing required columns (text, occurredAt) must surface as a 400 ValidationError, not a 500.
MISSING=$(req POST /notes "$TA" '{"data":{"recordId":"bad1"}}')
[[ "$(echo "$MISSING" | status)" == "400" ]] || fail "missing-required status: $MISSING"
[[ "$(echo "$MISSING" | body | jq -r .error.name)" == "ValidationError" ]] || fail "missing-required shape: $MISSING"

U=$(req PUT /notes/n2 "$TA" '{"data":{"text":"upsert-created","occurredAt":"2026-09-08T11:00:00.000Z"}}')
[[ "$(echo "$U" | status)" == "200" && "$(echo "$U" | body | jq -r .data.recordId)" == "n2" ]] || fail "put-create: $U"
U2=$(req PUT /notes/n2 "$TA" '{"data":{"text":"upsert-updated","occurredAt":"2026-09-08T11:00:00.000Z"}}')
[[ "$(echo "$U2" | body | jq -r .data.text)" == "upsert-updated" ]] || fail "put-update: $U2"

[[ "$(req GET /notes "$TA" | body | jq '.data|length')" == "2" ]] || fail "list count"

# Repeatable component round trip
S=$(req POST /activity-sessions "$TA" '{"data":{"recordId":"s1","quantities":[{"amount":2.5,"unit":"km"},{"amount":30,"unit":"min"}]}}')
# jq 1.7.1 (local) preserves "30.0" literally; jq 1.6 (Ubuntu/CI) prints "30" for the same float.
# Compare numerically instead of string-comparing the rendered JSON so both are stable across jq versions.
[[ "$(echo "$S" | body | jq '[.data.quantities[]|.amount] == [2.5,30]')" == "true" ]] || fail "child round trip: $S"

# Embedded component + null omission
T=$(req POST /transactions "$TA" '{"data":{"recordId":"t1","amount":{"minor":1999,"currency":"USD"},"occurredOn":"2026-09-08"}}')
[[ "$(echo "$T" | body | jq -c '.data.amount')" == '{"minor":1999,"currency":"USD"}' ]] || fail "embedded: $T"
[[ "$(echo "$T" | body | jq '.data|has("fee")')" == "false" ]] || fail "null omitted: $T"
# A `date` field round trips as YYYY-MM-DD, never as a full ISO datetime.
[[ "$(echo "$T" | body | jq -r '.data.occurredOn')" == "2026-09-08" ]] || fail "date round trip: $T"

# Catalog scoping: bob sees alice's public activity but not her private one
req POST /activities "$TA" '{"data":{"recordId":"a1","name":"run","visibility":"public"}}' >/dev/null
req POST /activities "$TA" '{"data":{"recordId":"a2","name":"swim","visibility":"private"}}' >/dev/null
B=$(req POST /auth/local/register '' '{"username":"bob","email":"bob@example.test","password":"secret1"}')
TB=$(echo "$B" | body | jq -r .jwt)
[[ "$(req GET /activities "$TB" | body | jq -c '[.data[].recordId]')" == '["a1"]' ]] || fail "catalog scope"

# Cross-owner: bob cannot see, update, or delete alice's note; PUT on her key is 404, not create
[[ "$(req GET /notes/n1 "$TB" | status)" == "404" ]] || fail "cross-owner show"
[[ "$(req PUT /notes/n1 "$TB" '{"data":{"text":"steal"}}' | status)" == "404" ]] || fail "cross-owner put"
[[ "$(req DELETE /notes/n1 "$TB" | status)" == "404" ]] || fail "cross-owner delete"
[[ "$(req GET /notes "$TB" | body | jq '.data|length')" == "0" ]] || fail "bob list empty"

[[ "$(req DELETE /notes/n1 "$TA" | status)" == "204" ]] || fail "delete"
[[ "$(req GET /notes/nope "$TA" | body | jq -r .error.name)" == "NotFoundError" ]] || fail "404 shape"
[[ "$(req GET /notes '' | status)" == "401" ]] || fail "unauthenticated"

# Tag has a read-only grant in the fixture (no create): creating one is a policy-denied 403.
FORBIDDEN=$(req POST /tags "$TA" '{"data":{"label":"x"}}')
[[ "$(echo "$FORBIDDEN" | status)" == "403" && "$(echo "$FORBIDDEN" | body | jq -r .error.name)" == "ForbiddenError" ]] || fail "forbidden shape: $FORBIDDEN"

echo "SMOKE OK"
