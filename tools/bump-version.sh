#!/usr/bin/env bash
# Set the app version everywhere it appears, or check that it's consistent.
#   tools/bump-version.sh 1.1.0   # set
#   tools/bump-version.sh --check # verify index.html and js/app.js agree
# Bump it whenever anything under js/ or styles.css changes, so browsers fetch
# the new files instead of reusing cached ones.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

current() { grep -oE "const VERSION = '[^']+'" js/app.js | head -1 | cut -d"'" -f2; }
assets() { grep -oE '(href="styles\.css|src="js/[A-Za-z0-9._-]+\.js)[^"]*"' index.html; }

check() {
  local v bad=0
  v="$(current)"
  [ -n "$v" ] || { echo "js/app.js has no line like: const VERSION = '1.2.3';"; return 1; }
  grep -q "<meta name=\"pindou-version\" content=\"$v\">" index.html || { echo "index.html's pindou-version meta tag doesn't say $v"; bad=1; }
  local refs; refs="$(assets)"
  [ -n "$refs" ] || { echo "index.html has no styles.css / js/*.js references"; return 1; }
  local stale; stale="$(echo "$refs" | grep -v "?v=$v\"\$")"
  [ -z "$stale" ] || { echo "these asset URLs aren't at ?v=$v:"; echo "$stale"; bad=1; }
  [ $bad = 0 ] && echo "OK: version $v is consistent ($(echo "$refs" | wc -l) asset URLs)"
  return $bad
}

if [ "${1:-}" = "--check" ]; then check; exit; fi
NEW="${1:-}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: tools/bump-version.sh X.Y.Z | --check" >&2; exit 2; }
# Make sure both places exist before changing either, so they can't drift apart.
[ -n "$(current)" ] || { echo "js/app.js has no VERSION line; nothing changed." >&2; exit 1; }
grep -q '<meta name="pindou-version" content="' index.html || { echo "index.html has no pindou-version meta tag; nothing changed." >&2; exit 1; }
sed -i -E "s/const VERSION = '[^']+'/const VERSION = '$NEW'/" js/app.js
sed -i -E "s/(<meta name=\"pindou-version\" content=\")[^\"]*/\1$NEW/" index.html
sed -i -E "s#((href=\"styles\.css|src=\"js/[A-Za-z0-9._-]+\.js))(\?v=[^\"]*)?\"#\1?v=$NEW\"#g" index.html
check
