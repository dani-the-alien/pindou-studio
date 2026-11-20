# Agent instructions: setting up Pindou Studio on a desktop

You're helping someone install Pindou Studio, a browser-based design tool for MARD 2.6mm fuse beads (拼豆), so they can open it from their app menu like any other program. The expected target is **Bazzite with KDE Plasma**. The steps below also work on other systemd + freedesktop Linux desktops.

The person you're helping may not be technical. Explain what you're about to do in plain language, and get their OK before changing anything on their computer. When something doesn't match what this file expects, stop and ask rather than improvising.

## How it works (so you can explain it)

- The app is static HTML/CSS/JS with no build step and no internet access needed.
- `desktop/install.sh` copies it to `~/.local/share/pindou-studio/app` and adds a **user** systemd service. The service runs python3's built-in web server on `http://127.0.0.1:8642/`, which only this computer can reach.
- It also adds a **Pindou Studio** entry with an icon to the app menu (category: Graphics). The entry starts the service if it isn't running and opens the page in the default browser.
- Everything lives in the user's home directory. Nothing needs root.

Why a local server instead of opening `index.html` directly: Bazzite's browsers are Flatpaks, which may not be allowed to read arbitrary folders. Also, browsers keep autosaved work per address, and a fixed `http://127.0.0.1:8642` address keeps that storage stable.

## Hard rules for this system

- **Bazzite is an immutable (Fedora Atomic) OS.** Do not use `rpm-ostree install`, `dnf`, `sudo`, or anything that layers or modifies system packages. Nothing here needs it. If something seems to need it, stop and ask.
- Don't change the port or switch between `127.0.0.1` and `localhost` after the person has started using the app. Either change makes the browser see a different site, so their autosaved design would seem to vanish. (It isn't deleted; it comes back at the original address.)
- Keep the server bound to `127.0.0.1`. Only make it reachable from other devices (a tablet, for example) if the person explicitly asks, and first explain that it has no password, so anyone on the network could open it.

## Setup steps

1. **Check the system** (read-only):
   ```bash
   cat /etc/os-release
   ```
   ```bash
   command -v python3 systemctl xdg-open flatpak
   ```
   ```bash
   ss -ltn | grep -w 8642 || echo "port 8642 is free"
   ```
   Expect `ID=bazzite` (or another Fedora/systemd distro), with python3 and systemctl present. If port 8642 is taken, pick another free port now and pass it as `PINDOU_PORT=<port>` in step 4. Use the same value in every later re-install.

2. **Put the folder somewhere durable** if it isn't already, for example `~/Applications/pindou-studio` (extracted from the tarball). Downloads is fine too. The installer copies what it needs, so this folder is only used for installing and updating.

3. **Read `desktop/install.sh`** (it's short), summarize it for the person, and ask two questions:
   - Do they want a **desktop icon** in addition to the app-menu entry? If yes, add `--desktop-shortcut`. Plasma may ask them to confirm they trust the launcher the first time they click it. That's expected.
   - Do they want it in **its own window** (no tabs or address bar) instead of a browser tab? That needs a Chromium-family browser installed as a Flatpak. Check with `flatpak list --app | grep -Ei 'chrome|chromium|brave|edge'`. If one exists, add `--app-window <flatpak-app-id>`. If not, use the default browser; don't install a browser just for this unless they ask. Whichever they pick, tell them it should stay that way, because each browser keeps its own autosaved work.

4. **Install** from inside the extracted folder:
   ```bash
   bash desktop/install.sh
   ```
   (Add the flags and `PINDOU_PORT=…` prefix chosen above.) It should end with `OK: server is answering at http://127.0.0.1:8642/`.

5. **Verify:**
   ```bash
   systemctl --user status pindou-studio --no-pager
   ```
   ```bash
   curl -sI http://127.0.0.1:8642/ | head -1
   ```
   Then have the person open **Pindou Studio** from the app menu (search "Pindou" or look under Graphics). If it doesn't appear right away, log out and back in, or run `kbuildsycoca6`.

6. **Tell them about saving.** The app autosaves only the *current* design, inside the browser. Anything they want to keep long-term should be saved with the **Save** button, which downloads a `.pindou.json` file. Suggest a folder like `~/Documents/Pindou`. **Open** loads those files back. Clearing browser data erases the autosave but not saved files.

## Updating to a newer version

Extract the new tarball and run `bash desktop/install.sh` again with the same flags and port. That replaces the app files; the browser-stored design is kept. If the page looks stale afterwards, a hard refresh (Ctrl+Shift+R) fixes it. The installer already cache-busts the scripts, so this should be rare.

## Uninstalling

```bash
bash desktop/uninstall.sh
```
This removes the service, menu entry, icon and installed copy. It doesn't touch saved `.pindou.json` files or the browser's stored data.

## Troubleshooting

- **Menu entry does nothing / page won't load:** run `journalctl --user -u pindou-studio -n 50 --no-pager`. A message like "Address already in use" means another program has the port: re-run the installer with a different `PINDOU_PORT`, and tell the person their autosave stays with the old address.
- **Service not running after a reboot:** `systemctl --user enable --now pindou-studio`.
- **Wrong browser opens:** the menu entry uses the system default browser (`xdg-open`). They can change that in System Settings → Default Applications, or you can re-install with `--app-window`.

## About the colors

Hex values for MARD colors are community-sourced approximations (see `README.md`); screens and photos vary. For close calls, compare against a physical MARD color card.
