#!/usr/bin/env bash
# Removes everything desktop/install.sh added. Designs autosaved in the browser
# are not touched (they live in the browser's own storage), and neither are any
# .pindou.json files you saved.
set -uo pipefail
absdir() { case "$1" in /*) echo "$1" ;; *) echo "$2" ;; esac; }
DATA="$(absdir "${XDG_DATA_HOME:-}" "$HOME/.local/share")"
CONF="$(absdir "${XDG_CONFIG_HOME:-}" "$HOME/.config")"

if ! systemctl --user disable --now pindou-studio.service >/dev/null 2>&1; then
  echo "Note: couldn't stop the service through systemctl --user; if it's running it will stop at logout." >&2
fi
rm -f "$CONF/systemd/user/pindou-studio.service" "$CONF/systemd/user/default.target.wants/pindou-studio.service"
systemctl --user daemon-reload >/dev/null 2>&1
systemctl --user reset-failed pindou-studio.service >/dev/null 2>&1
rm -f "$DATA/applications/pindou-studio.desktop" "$DATA/icons/hicolor/scalable/apps/pindou-studio.svg"
DESK_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
rm -f "$DESK_DIR/pindou-studio.desktop"
rm -rf "$DATA/pindou-studio" "$CONF/pindou-studio"
update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
kbuildsycoca6 >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true
echo "Pindou Studio removed."
