#!/usr/bin/env bash
# Removes everything install.sh added. Designs autosaved in the browser are not
# touched (they live in the browser's own storage), and neither are any
# .pindou.json files the user saved.
set -uo pipefail
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
systemctl --user disable --now pindou-studio.service 2>/dev/null
rm -f "$CONF/systemd/user/pindou-studio.service"
systemctl --user daemon-reload 2>/dev/null
rm -f "$DATA/applications/pindou-studio.desktop" "$DATA/icons/hicolor/scalable/apps/pindou-studio.svg"
DESK_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
rm -f "$DESK_DIR/pindou-studio.desktop"
rm -rf "$DATA/pindou-studio"
update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
kbuildsycoca6 >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true
echo "Pindou Studio removed."
