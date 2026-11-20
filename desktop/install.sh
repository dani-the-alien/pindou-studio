#!/usr/bin/env bash
# Pindou Studio: per-user desktop install (systemd + freedesktop launcher).
#
# Everything goes under the user's home directory. No root, no system packages,
# nothing layered onto an immutable OS image. Safe to re-run: re-running updates
# the app in place, and designs saved in the browser are kept.
#
# What it does:
#   1. copies the app to   ~/.local/share/pindou-studio/app
#   2. adds a user service ~/.config/systemd/user/pindou-studio.service that runs
#      python3's built-in web server on 127.0.0.1:$PORT (this computer only)
#   3. adds a menu entry   ~/.local/share/applications/pindou-studio.desktop
#      and its icon        ~/.local/share/icons/hicolor/scalable/apps/pindou-studio.svg
#
# Options:
#   --app-window ID    open in its own window using a Chromium-family Flatpak
#                      (e.g. com.google.Chrome, org.chromium.Chromium, com.brave.Browser)
#                      instead of the default browser
#   --desktop-shortcut also put a launcher icon on the desktop
# Environment:
#   PINDOU_PORT        port to serve on (default 8642). Choose it once and keep it:
#                      the browser keeps autosaved work per address, so a new port
#                      looks like a fresh, empty app.
set -euo pipefail

PORT="${PINDOU_PORT:-8642}"
APP_WINDOW=""
DESKTOP_SHORTCUT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app-window) APP_WINDOW="${2:?--app-window needs a Flatpak app ID}"; shift 2 ;;
    --desktop-shortcut) DESKTOP_SHORTCUT=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
APPDIR="$DATA/pindou-studio"
UNIT="$CONF/systemd/user/pindou-studio.service"
DESKTOP_FILE="$DATA/applications/pindou-studio.desktop"
ICON="$DATA/icons/hicolor/scalable/apps/pindou-studio.svg"
URL="http://127.0.0.1:$PORT/"

PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "python3 was not found. Stop and ask before installing anything." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemctl was not found." >&2; exit 1; }
[ -f "$SRC/index.html" ] && [ -f "$SRC/js/app.js" ] || { echo "Run this from inside the extracted pindou-studio folder." >&2; exit 1; }
case "$PORT" in ''|*[!0-9]*) echo "PINDOU_PORT must be a number" >&2; exit 2 ;; esac
if [ -n "$APP_WINDOW" ] && ! flatpak info "$APP_WINDOW" >/dev/null 2>&1; then
  echo "Flatpak '$APP_WINDOW' is not installed (see: flatpak list --app)." >&2; exit 1
fi

echo "Installing Pindou Studio to $APPDIR (served at $URL)"

# 1. app files. Build the new copy beside the old one, then swap.
mkdir -p "$APPDIR"
rm -rf "$APPDIR/app.new"
mkdir "$APPDIR/app.new"
cp -r "$SRC/index.html" "$SRC/styles.css" "$SRC/js" "$SRC/data" "$APPDIR/app.new/"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$APPDIR/app.new/"
# Cache-bust the script/style URLs so the browser can't mix an old app.js with a new page.
STAMP="$(date +%s)"
sed -i -E "s#(href=\"styles\.css|src=\"js/[a-z]+\.js)\"#\1?v=$STAMP\"#g" "$APPDIR/app.new/index.html"
rm -rf "$APPDIR/app"
mv "$APPDIR/app.new" "$APPDIR/app"

# launcher script: make sure the server is up, then open the page
if [ -n "$APP_WINDOW" ]; then
  OPEN_CMD="flatpak run $APP_WINDOW --app=\"\$URL\""
else
  OPEN_CMD="xdg-open \"\$URL\""
fi
cat > "$APPDIR/launch.sh" <<LAUNCH
#!/usr/bin/env bash
URL="$URL"
systemctl --user start pindou-studio.service
for _ in \$(seq 1 50); do
  (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break
  sleep 0.1
done
exec $OPEN_CMD
LAUNCH
chmod +x "$APPDIR/launch.sh"

# 2. user service
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNITFILE
[Unit]
Description=Pindou Studio (local web server for the bead pattern designer)

[Service]
ExecStart="$PY" -m http.server $PORT --bind 127.0.0.1 --directory "$APPDIR/app"
Restart=on-failure

[Install]
WantedBy=default.target
UNITFILE
systemctl --user daemon-reload
systemctl --user enable pindou-studio.service >/dev/null
systemctl --user restart pindou-studio.service

# 3. menu entry + icon
mkdir -p "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON")"
cp "$SRC/desktop/pindou-studio.svg" "$ICON"
cat > "$DESKTOP_FILE" <<DESK
[Desktop Entry]
Type=Application
Name=Pindou Studio
GenericName=Bead Pattern Designer
Comment=Design fuse bead (拼豆) patterns for MARD beads
Exec="$APPDIR/launch.sh"
Icon=pindou-studio
Terminal=false
Categories=Graphics;2DGraphics;
Keywords=beads;perler;hama;fuse;pindou;pixel;pattern;
DESK
if [ "$DESKTOP_SHORTCUT" = 1 ]; then
  DESK_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
  mkdir -p "$DESK_DIR"
  cp "$DESKTOP_FILE" "$DESK_DIR/pindou-studio.desktop"
  chmod +x "$DESK_DIR/pindou-studio.desktop"
fi
update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
gtk-update-icon-cache -q "$DATA/icons/hicolor" >/dev/null 2>&1 || true
kbuildsycoca6 >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true

# check it actually answers
for _ in $(seq 1 50); do
  (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null && { echo "OK: server is answering at $URL"; exit 0; }
  sleep 0.1
done
echo "The service was installed but isn't answering yet. Check: journalctl --user -u pindou-studio -n 50" >&2
exit 1
