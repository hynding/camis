#!/usr/bin/env bash
# A self-signed certificate for fake-oauth-provider.mjs on 127.0.0.1, which the caller then trusts
# system-wide (update-ca-certificates) so both runtimes verify it as they would a real provider's.
# usage: fake-oauth-cert.sh <dir>   → <dir>/fake-oauth.crt, <dir>/fake-oauth.key
set -euo pipefail
mkdir -p "$1"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=camis fake OAuth provider" \
  -addext "subjectAltName=IP:127.0.0.1" -addext "basicConstraints=critical,CA:TRUE" \
  -keyout "$1/fake-oauth.key" -out "$1/fake-oauth.crt" 2>/dev/null
