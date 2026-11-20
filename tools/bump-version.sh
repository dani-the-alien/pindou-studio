#!/usr/bin/env bash
# Set the app version everywhere it appears, or check that it's consistent.
#   tools/bump-version.sh 0.3.0   # set
#   tools/bump-version.sh --check # verify index.html and js/app.js agree
# Bump it whenever any file under js/ or styles.css changes, so browsers fetch
# the new files instead of reusing cached ones.
set -euo pipefail
cd "$(dirname "$0")/.."
current() { grep -oE "const VERSION = '[^']+'" js/app.js | cut -d"'" -f2; }
check() {
  local v; v="$(current)"
  local bad=0
  grep -q "<meta name=\"pindou-version\" content=\"$v\">" index.html || { echo "index.html meta tag doesn't say $v"; bad=1; }
  local refs; refs="$(grep -oE '(styles\.css|js/[a-z]+\.js)\?v=[^"]*' index.html)"
  [ "$(echo "$refs" | wc -l)" -eq 4 ] || { echo "expected 4 versioned asset URLs, found:"; echo "$refs"; bad=1; }
  echo "$refs" | grep -v "?v=$v\$" && { echo "^ asset URLs not at $v"; bad=1; }
  [ $bad = 0 ] && echo "OK: version $v is consistent"
  return $bad
}
if [ "${1:-}" = "--check" ]; then check; exit; fi
NEW="${1:?usage: tools/bump-version.sh X.Y.Z | --check}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.3" >&2; exit 2; }
sed -i -E "s/const VERSION = '[^']+'/const VERSION = '$NEW'/" js/app.js
sed -i -E "s/(<meta name=\"pindou-version\" content=\")[^\"]*/\1$NEW/; s#((styles\.css|js/[a-z]+\.js)\?v=)[^\"]*#\1$NEW#g" index.html
check
