#!/usr/bin/env bash
# Pindou Studio: per-user desktop install (systemd user service + app-menu entry).
#
# Everything goes under your home directory. No root, no system packages, nothing
# layered onto an immutable OS image. Safe to re-run: re-running updates the app
# in place, keeps the same port and options, and keeps designs saved in the browser.
#
# What it does:
#   1. copies the app to    ~/.local/share/pindou-studio/app
#   2. adds a user service  ~/.config/systemd/user/pindou-studio.service, which runs
#      desktop/serve.py on 127.0.0.1:PORT (this computer only)
#   3. adds a menu entry    ~/.local/share/applications/pindou-studio.desktop
#      and its icon         ~/.local/share/icons/hicolor/scalable/apps/pindou-studio.svg
#   4. remembers its options in ~/.config/pindou-studio/install.conf
#
# Options:
#   --app-window ID     open in its own window using a Chromium-family Flatpak
#                       (e.g. com.google.Chrome, org.chromium.Chromium, com.brave.Browser)
#   --browser-tab       go back to opening in the default browser
#   --desktop-shortcut  also put a launcher icon on the desktop
# Environment:
#   PINDOU_PORT         port to serve on (1024-65535). Defaults to the port used last
#                       time, or 8642. Keep it the same once someone has used the app:
#                       the browser keeps autosaved work per address.
set -euo pipefail

die() { echo "Error: $*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
absdir() { case "$1" in /*) echo "$1" ;; *) echo "$2" ;; esac; }   # XDG says: ignore relative values
DATA="$(absdir "${XDG_DATA_HOME:-}" "$HOME/.local/share")"
CONF="$(absdir "${XDG_CONFIG_HOME:-}" "$HOME/.config")"
APPDIR="$DATA/pindou-studio"
CONFFILE="$CONF/pindou-studio/install.conf"
UNIT="$CONF/systemd/user/pindou-studio.service"
DESKTOP_FILE="$DATA/applications/pindou-studio.desktop"
ICON="$DATA/icons/hicolor/scalable/apps/pindou-studio.svg"

# Options from last time, then the command line.
SAVED_PORT=""; SAVED_APP_WINDOW=""
if [ -f "$CONFFILE" ]; then
  SAVED_PORT="$(sed -n 's/^PORT=\([0-9]*\)$/\1/p' "$CONFFILE")"
  SAVED_APP_WINDOW="$(sed -n 's/^APP_WINDOW=\([A-Za-z0-9._-]*\)$/\1/p' "$CONFFILE")"
fi
PORT="${PINDOU_PORT:-${SAVED_PORT:-8642}}"
APP_WINDOW="$SAVED_APP_WINDOW"
DESKTOP_SHORTCUT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app-window) APP_WINDOW="${2:?--app-window needs a Flatpak app ID}"; shift 2 ;;
    --browser-tab) APP_WINDOW=""; shift ;;
    --desktop-shortcut) DESKTOP_SHORTCUT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ---------- checks first: nothing is changed until these pass ----------
[ -f "$SRC/index.html" ] && [ -f "$SRC/js/app.js" ] && [ -f "$SRC/desktop/serve.py" ] \
  || die "run this from inside the pindou-studio folder (desktop/install.sh)."
if [ -e /run/.containerenv ] || [ -e /run/.toolboxenv ]; then
  die "this looks like a distrobox/toolbox container. Run the installer in a normal host terminal instead."
fi
case "$PORT" in ''|*[!0-9]*) die "PINDOU_PORT must be a number." ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "PINDOU_PORT must be between 1024 and 65535."
[[ "$APP_WINDOW" =~ ^[A-Za-z0-9._-]*$ ]] || die "--app-window must be a Flatpak app ID like com.google.Chrome."
# Paths end up in a systemd unit and a .desktop file, where % $ " ` \ have special meaning.
case "$APPDIR" in *[%\$\"\`\\]*) die "the install path ($APPDIR) contains one of % \$ \" \` \\ which the service and menu files can't hold safely." ;; esac

# Prefer the system Python: Homebrew or virtualenv Pythons can disappear later.
if [ -x /usr/bin/python3 ]; then PY=/usr/bin/python3; else PY="$(command -v python3 || true)"; fi
[ -n "$PY" ] || die "python3 was not found. Stop and ask before installing anything."
command -v systemctl >/dev/null || die "systemctl was not found."
systemctl --user show-environment >/dev/null 2>&1 \
  || die "can't reach your user service manager (systemctl --user). Run this from a normal desktop session terminal."
if [ -n "$APP_WINDOW" ] && ! flatpak info "$APP_WINDOW" >/dev/null 2>&1; then
  die "Flatpak '$APP_WINDOW' is not installed (see: flatpak list --app)."
fi

# Does Pindou Studio (and not some other program) answer on the port?
answering() { (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; }
is_ours() {
  "$PY" -c 'import sys, urllib.request
try:
    body = urllib.request.urlopen("http://127.0.0.1:%s/" % sys.argv[1], timeout=2).read()
except Exception:
    sys.exit(1)
sys.exit(0 if b"name=\"pindou-version\"" in body else 1)' "$PORT"
}
if answering && ! is_ours; then
  die "another program is already using port $PORT. Pick a free port with PINDOU_PORT=<port> (if Pindou Studio was used before at another port, ask before switching: autosaved work stays with the old address)."
fi

URL="http://127.0.0.1:$PORT/"
echo "Installing Pindou Studio to $APPDIR (served at $URL)"

# ---------- 1. app files: build the new copy beside the old one, then swap ----------
mkdir -p "$APPDIR"
rm -rf "$APPDIR/app.new"
mkdir "$APPDIR/app.new"
cp -r "$SRC/index.html" "$SRC/styles.css" "$SRC/js" "$SRC/data" "$APPDIR/app.new/"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$APPDIR/app.new/"
# Add an install stamp to script/style URLs (on top of the app's own ?v=version).
STAMP="$(date +%s)"
sed -i -E "s#(href=\"styles\.css|src=\"js/[A-Za-z0-9._-]+\.js)(\?v=([^\"]*))?\"#\1?v=\3-$STAMP\"#g" "$APPDIR/app.new/index.html"
rm -rf "$APPDIR/app"
mv "$APPDIR/app.new" "$APPDIR/app"
cp "$SRC/desktop/serve.py" "$APPDIR/serve.py"

# Launcher: make sure the server is up, then open the page (or explain why not).
if [ -n "$APP_WINDOW" ]; then OPEN_CMD="flatpak run $APP_WINDOW --app=\"\$URL\""; else OPEN_CMD="xdg-open \"\$URL\""; fi
cat > "$APPDIR/launch.sh" <<LAUNCH
#!/usr/bin/env bash
URL="$URL"
systemctl --user start pindou-studio.service
for _ in \$(seq 1 50); do
  if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then exec $OPEN_CMD; fi
  sleep 0.1
done
MSG="Pindou Studio's local server didn't start. Details: journalctl --user -u pindou-studio -n 50"
notify-send -i pindou-studio "Pindou Studio" "\$MSG" 2>/dev/null || kdialog --error "\$MSG" 2>/dev/null || echo "\$MSG" >&2
exit 1
LAUNCH
chmod +x "$APPDIR/launch.sh"

# ---------- 2. user service ----------
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNITFILE
[Unit]
Description=Pindou Studio (local web server for the bead pattern designer)

[Service]
ExecStart="$PY" "$APPDIR/serve.py" --port $PORT --dir "$APPDIR/app"
Restart=on-failure

[Install]
WantedBy=default.target
UNITFILE
systemctl --user daemon-reload
systemctl --user enable pindou-studio.service >/dev/null
systemctl --user restart pindou-studio.service

# ---------- 3. menu entry + icon ----------
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
StartupNotify=false
Categories=Graphics;2DGraphics;
Keywords=beads;perler;hama;fuse;pindou;pixel;pattern;
DESK
DESK_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ "$DESKTOP_SHORTCUT" = 1 ] || [ -f "$DESK_DIR/pindou-studio.desktop" ]; then
  mkdir -p "$DESK_DIR"
  cp "$DESKTOP_FILE" "$DESK_DIR/pindou-studio.desktop"
  chmod +x "$DESK_DIR/pindou-studio.desktop"
fi
update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
kbuildsycoca6 >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true

# ---------- 4. remember the options for next time ----------
mkdir -p "$(dirname "$CONFFILE")"
printf 'PORT=%s\nAPP_WINDOW=%s\n' "$PORT" "$APP_WINDOW" > "$CONFFILE"

# ---------- check that Pindou Studio itself answers ----------
for _ in $(seq 1 50); do
  if systemctl --user is-active --quiet pindou-studio.service && is_ours; then
    echo "OK: Pindou Studio is answering at $URL"
    exit 0
  fi
  sleep 0.1
done
die "the service was installed but Pindou Studio isn't answering at $URL. Check: journalctl --user -u pindou-studio -n 50"
