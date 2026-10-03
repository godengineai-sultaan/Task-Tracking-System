#!/bin/bash
# Post-deploy smoke test through the public entry point (Caddy / Cloudflare).
# Usage: deploy/smoke-test.sh https://app.example.com
# Optional sign-in check with a dedicated low-privilege account: SMOKE_ORG, SMOKE_EMAIL, SMOKE_PASSWORD (env only).
# SMOKE_INSECURE=1 accepts a self-signed certificate (local drills only). Exit status 1 if any check fails.
set -euo pipefail
BASE=${1:?usage: smoke-test.sh <base-url>}; BASE=${BASE%/}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
CURL=(curl -sS --max-time 20 -o "$TMP/body" -D "$TMP/head" -w '%{http_code}')
[ "${SMOKE_INSECURE:-0}" = 1 ] && CURL+=(-k)
FAIL=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAIL=1; }
hdr() { grep -i "^$1:" "$TMP/head" | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
get() { : > "$TMP/body"; : > "$TMP/head"; "${CURL[@]}" "$@" 2>/dev/null || true; }   # prints the HTTP status (000 = no response)

code=$(get "$BASE/api/health/live"); [ "$code" = 200 ] && pass "liveness 200" || fail "liveness returned $code"
code=$(get "$BASE/api/health/ready"); [ "$code" = 200 ] && grep -q '"ok":true' "$TMP/body" && pass "readiness 200 (database reachable)" || fail "readiness returned $code"
code=$(get "$BASE/")
if [ "$code" = 200 ] && grep -q '<div id="root"' "$TMP/body"; then pass "app shell 200"; else fail "app shell returned $code"; fi
case "$BASE" in *localhost*|*127.0.0.1*) ;; *) grep -qi 'localhost\|127\.0\.0\.1' "$TMP/body" && fail "app shell references localhost" || pass "no localhost remnants in app shell";; esac
[ "$(hdr cache-control)" = no-cache ] && pass "index.html cache-control: no-cache" || fail "index.html cache-control is '$(hdr cache-control)'"
[ "$(hdr x-content-type-options)" = nosniff ] && pass "security header x-content-type-options" || fail "missing x-content-type-options"
case "$BASE" in https://*) [ -n "$(hdr strict-transport-security)" ] && pass "HSTS present" || echo "WARN  no Strict-Transport-Security header";; esac
ASSET=$(grep -o '/assets/[^"]*\.js' "$TMP/body" | head -1 || true)
if [ -n "$ASSET" ]; then
  code=$(get "$BASE$ASSET")
  [ "$code" = 200 ] && hdr cache-control | grep -q immutable && pass "hashed asset $ASSET immutable" || fail "asset $ASSET returned $code, cache-control '$(hdr cache-control)'"
else fail "no /assets/*.js referenced by index.html"; fi
code=$(get "$BASE/sw.js"); [ "$code" = 200 ] && [ "$(hdr cache-control)" = no-cache ] && pass "service worker no-cache" || fail "sw.js returned $code, cache-control '$(hdr cache-control)'"
code=$(get "$BASE/api/me"); [ "$code" = 401 ] && [ "$(hdr cache-control)" = no-store ] && pass "private API 401 + no-store when signed out" || fail "/api/me signed out returned $code, cache-control '$(hdr cache-control)'"

if [ -n "${SMOKE_EMAIL:-}" ]; then
  JAR="$TMP/jar"
  body=$(printf '{"organization":"%s","email":"%s","password":"%s"}' "${SMOKE_ORG:?SMOKE_ORG required}" "$SMOKE_EMAIL" "${SMOKE_PASSWORD:?SMOKE_PASSWORD required}")
  code=$(get -c "$JAR" -H 'content-type: application/json' -H 'x-requested-with: fetch' --data-binary @- "$BASE/api/auth/login" <<<"$body")
  [ "$code" = 200 ] && pass "sign-in 200" || fail "sign-in returned $code"
  [ "$(hdr set-cookie | grep -ci 'secure')" -ge 1 ] && pass "session cookie Secure" || { case "$BASE" in https://*) fail "session cookie not Secure";; esac; }
  code=$(get -b "$JAR" "$BASE/api/me"); [ "$code" = 200 ] && pass "authenticated /api/me 200" || fail "authenticated /api/me returned $code"
  get -b "$JAR" -X POST -H 'x-requested-with: fetch' "$BASE/api/auth/logout" >/dev/null
fi
[ "$FAIL" = 0 ] && echo "SMOKE TEST PASSED ($BASE)" || echo "SMOKE TEST FAILED ($BASE)"
exit "$FAIL"
