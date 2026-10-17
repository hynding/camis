#!/usr/bin/env bash
# The publish grant is enforced, not described: a caller who may create and update Posts but not
# publish them gets 403 for every write that would publish, nothing is written, and status=draft
# still works. usage: strapi-publish-grant.sh <api-base> <token of such a caller>
set -euo pipefail
BASE="${1:?usage: strapi-publish-grant.sh <api-base> <token>}"
T="${2:?token}"

fail() { echo "PUBLISH GRANT FAIL: $*" >&2; exit 1; }
req() { # method path body → prints "<status>\n<body>"
  local args=(-s -g -o /tmp/publish-grant-body -w '%{http_code}' -X "$1" -H 'Accept: application/json' -H 'Content-Type: application/json' -H "Authorization: Bearer $T")
  [[ -n "${3:-}" ]] && args+=(--data "$3")
  curl "${args[@]}" "$BASE$2"; echo; cat /tmp/publish-grant-body; echo
}
st() { sed -n 1p; }
body() { sed -n 2p; }
drafts() { req GET '/posts?status=draft&fields[0]=title' | body | jq -r '[.data[].title] | join(",")'; }

DENIED=$(req POST /posts '{"data":{"title":"Denied"}}')
[[ "$(echo "$DENIED" | st)" == "403" && "$(echo "$DENIED" | body | jq -r .error.name)" == "ForbiddenError" ]] || fail "create that publishes: $DENIED"
[[ "$(drafts)" == "" ]] || fail "a denied create left a draft: $(drafts)"

DRAFT=$(req POST '/posts?status=draft' '{"data":{"title":"Draft"}}')
[[ "$(echo "$DRAFT" | st)" == "201" && "$(echo "$DRAFT" | body | jq -r .data.publishedAt)" == "null" ]] || fail "create a draft: $DRAFT"
ID=$(echo "$DRAFT" | body | jq -r .data.documentId)

UPDATE=$(req PUT "/posts/$ID" '{"data":{"title":"Changed"}}')
[[ "$(echo "$UPDATE" | st)" == "403" ]] || fail "update that publishes: $UPDATE"
[[ "$(drafts)" == "Draft" ]] || fail "a denied update changed the draft: $(drafts)"
[[ "$(req GET "/posts/$ID" | st)" == "404" ]] || fail "a denied update published the document"

[[ "$(req PUT "/posts/$ID?status=draft" '{"data":{"title":"Changed"}}' | st)" == "200" ]] || fail "update the draft"
[[ "$(drafts)" == "Changed" ]] || fail "draft update: $(drafts)"
echo "PUBLISH GRANT OK"
