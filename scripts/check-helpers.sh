#!/bin/sh
# Rebuilds the helper binaries kept in helpers/ from their source and fails unless each is byte for byte the one
# committed, and unless its Shard pins the committed file's SHA-256 (index.js) and states it (README.md).
# One helper today: nordtv, the WireGuard program of the vpn Shard (source in plugins/vpn/nordtv/).
#   sh scripts/check-helpers.sh      needs Go 1.21 or later, which fetches the pinned Go itself (GOTOOLCHAIN)
set -eu
cd "$(dirname "$0")/.."
sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
fail() { echo "FAIL $*" >&2; exit 1; }

shard=plugins/vpn
pin=$(grep '^var BINARY = ' "$shard/index.js") || fail "$shard/index.js has no var BINARY line"
url=$(printf '%s\n' "$pin" | sed -n "s/.*url: '\([^']*\)'.*/\1/p")
want=$(printf '%s\n' "$pin" | sed -n "s/.*sha256: '\([0-9a-f]\{64\}\)'.*/\1/p")
base=https://raw.githubusercontent.com/andrearicci93/vetro-plugins/main/helpers/
case "$url" in "$base"*) ;; *) fail "$shard downloads $url, not a file in helpers/ of this repo";; esac
file=helpers/${url#"$base"}
[ -f "$file" ] || fail "$file is pinned by $shard but missing"
[ "$(sum < "$file")" = "$want" ] || fail "$file does not have the SHA-256 pinned in $shard/index.js ($want)"
grep -q "$want" "$shard/README.md" || fail "$shard/README.md does not state the SHA-256 $want"

out=$(mktemp -d); trap 'rm -rf "$out"' EXIT
(cd "$shard/nordtv" &&
  GOTOOLCHAIN=go1.26.0 CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 GOFLAGS=-mod=readonly \
    go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$out/nordtv-armv7" .)
built=$(sum < "$out/nordtv-armv7")
[ "$(gunzip -c "$file" | sum)" = "$built" ] || fail "$file is not what $shard/nordtv/ builds to ($built)"
grep -q "$built" "$shard/README.md" || fail "$shard/README.md does not state the program's SHA-256 $built"
echo "PASS $file: built from $shard/nordtv/ with go1.26.0 (program $built), pinned as $want"
