# Installing Pindou Studio on a desktop: instructions for an AI assistant

Read this only when someone has asked you to install (or update, or remove) Pindou Studio on their computer. If you're working on the code instead, see `AGENTS.md` in the repo root.

You're helping someone install Pindou Studio, a browser-based design tool for MARD 2.6mm fuse beads (拼豆), so they can open it from their app menu like any other program. The expected target is **Bazzite with KDE Plasma**; the steps also work on other systemd + freedesktop Linux desktops.

The person you're helping may not be technical. Explain what you're about to do in plain language, and get their OK before changing anything on their computer. When something doesn't match what this file expects, stop and ask rather than improvising.

## How it works (so you can explain it)

- The app is static HTML/CSS/JS: no build step, no internet access needed, nothing uploaded anywhere.
- `desktop/install.sh` copies it to `~/.local/share/pindou-studio/app` and adds a **user** systemd service that runs `desktop/serve.py`, a tiny web server on `http://127.0.0.1:8642/` that only this computer can reach.
- It adds a **Pindou Studio** entry with an icon to the app menu (category: Graphics). The entry starts the service if needed and opens the page in the default browser, or in its own window if they chose that.
- It remembers its options (port, window mode) in `~/.config/pindou-studio/install.conf`, so running it again later is a safe update.
- Everything lives in the person's home directory. Nothing needs root.

Why a local server instead of opening `index.html` directly: Bazzite's browsers are Flatpaks, which may not be allowed to read arbitrary folders. Also, browsers keep autosaved work per address, and a fixed `http://127.0.0.1:8642` keeps that storage stable.

## Hard rules

- **Bazzite is an immutable (Fedora Atomic) OS.** Don't use `rpm-ostree install`, `dnf`, `sudo`, or anything that layers or modifies system packages. Nothing here needs it. If something seems to, stop and ask.
- **Run on the host, not in a container.** If your shell is inside distrobox or toolbox (`/run/.containerenv` or `/run/.toolboxenv` exists), stop and ask the person to run the commands in a normal host terminal (Konsole). The installer refuses to run in a container anyway.
- **Don't change where the app lives in the browser once it's been used:** that means the port, `127.0.0.1` vs `localhost`, and which browser opens it. Any of those makes the browser see a different site, so their autosaved design would seem to vanish. (It isn't deleted; it comes back at the original address and browser.) If a change is truly needed, **first have them press Save** in Pindou Studio to download their design as a `.pindou.json` file, and explain they can **Open** it afterwards.
- Keep the server bound to `127.0.0.1`. Only make it reachable from other devices (a tablet, say) if the person explicitly asks, and first explain that it has no password, so anyone on the network could open it.

## First install

1. **Check the system** (read-only):
   ```bash
   cat /etc/os-release
   ```
   ```bash
   command -v python3 systemctl xdg-open flatpak
   ```
   ```bash
   ls /run/.containerenv /run/.toolboxenv 2>/dev/null || echo "not in a container"
   ```
   ```bash
   systemctl --user cat pindou-studio 2>/dev/null | grep ExecStart || echo "not installed yet"
   ```
   Expect `ID=bazzite` (or another Fedora/systemd distro), python3 and systemctl present, not in a container. If the last command shows an existing install, this is an **update**: skip to "Updating" below.

   Also ask: **have they used Pindou Studio before**, somewhere else (another address such as `127.0.0.1:8000` or `localhost`, another browser, or the website)? A design autosaved there won't appear in the new install. If so, have them open it there and press **Save** first, so they can **Open** the file afterwards.

2. **Put the folder somewhere durable** if it isn't already, for example `~/Applications/pindou-studio` (a `git clone` or an extracted tarball). The installer copies what it needs, so this folder is only used for installing and updating.

3. **Read `desktop/install.sh`** (it's short), summarize it for the person, and ask two questions:
   - Do they want a **desktop icon** as well as the app-menu entry? If yes, add `--desktop-shortcut`. Plasma may ask them to confirm they trust the launcher the first time they click it; that's expected.
   - Do they want it in **its own window** (no tabs or address bar) instead of a browser tab? That needs a Chromium-family browser installed as a Flatpak. Check for one of these exact IDs:
     ```bash
     flatpak list --app --columns=application | grep -xE 'com\.google\.Chrome|org\.chromium\.Chromium|com\.brave\.Browser|com\.microsoft\.Edge|com\.vivaldi\.Vivaldi|io\.github\.ungoogled_software\.ungoogled_chromium'
     ```
     If one is listed, add `--app-window <that-id>`. If not, use the default browser; don't install a browser just for this unless they ask. Tell them whichever they pick should stay that way, because each browser keeps its own autosaved work.

4. **Install** from inside the folder:
   ```bash
   bash desktop/install.sh
   ```
   (Add the flags chosen above.) The default port is 8642. On a first install, if it says another program is using the port, pick a free one with `PINDOU_PORT=<1024-65535> bash desktop/install.sh`; it's remembered from then on. A successful run ends with `OK: Pindou Studio is answering at http://127.0.0.1:8642/`.

5. **Verify:**
   ```bash
   systemctl --user status pindou-studio --no-pager
   ```
   ```bash
   curl -s http://127.0.0.1:8642/ | grep -o 'pindou-version" content="[^"]*'
   ```
   The second command should print the app version (use their port if it isn't 8642). Then have them open **Pindou Studio** from the app menu (search "Pindou", or look under Graphics). If it doesn't appear right away, run `kbuildsycoca6` or log out and back in. The status bar at the bottom of the app shows its version.

6. **Tell them about saving.** The app autosaves only the *current* design, inside the browser. Anything they want to keep should be saved with **Save**, which downloads a `.pindou.json` file; suggest a folder like `~/Documents/Pindou`. **Open** loads those files back. Clearing browser data erases the autosave but not saved files.

## Updating

Get the new version into the same folder (`git pull`, or extract the new tarball over it), then run the installer again **with no port and no browser options**:
```bash
bash desktop/install.sh
```
It reuses the port and window mode from last time (for installs made by older versions of the installer, it reads them from the existing service and launcher), replaces the app files, and keeps their autosaved design. It refuses to change the port or window mode during an update unless given `--change-address`; only use that after the person has pressed **Save**.

## Uninstalling

```bash
bash desktop/uninstall.sh
```
Removes the service, menu entry, icon, desktop shortcut and installed copy. It keeps the remembered port and window mode (`~/.config/pindou-studio/install.conf`), so reinstalling brings the app back at the same address with its autosaved design; delete that file to forget them. It doesn't touch saved `.pindou.json` files or the browser's stored data.

## Troubleshooting

- **The menu entry shows a "server didn't start" notice, or the page won't load:** `journalctl --user -u pindou-studio -n 50 --no-pager`. "Address already in use" means another program took the port. Find it with `ss -ltnp 'sport = :8642'` (their port), tell the person what it is, and with their OK stop or reconfigure it, then `systemctl --user restart pindou-studio`. Their design is still there once the port is free. Moving Pindou Studio to another port is a last resort: their autosaved design stays at the old address, which they can't open while the other program holds it, so they'd start empty at the new one (`PINDOU_PORT=<port> bash desktop/install.sh --change-address`).
- **Service not running after a reboot:** `systemctl --user enable --now pindou-studio`.
- **Something new is missing after an update** (an empty dropdown, a button that does nothing): have them press Ctrl+Shift+R once. Compare the version in the status bar (in a small window, at the bottom of the ⋯ menu) with `const VERSION` in `js/app.js` of the folder you installed from.
- **"Open in another tab"** when opening the app: it's already open in another window or tab, and only one edits at a time. That's expected; close the other one, or press **Edit here instead**.
- **Wrong browser opens:** the menu entry uses the system default browser (`xdg-open`). Before changing it, have them **Save** their design (see the hard rules). Then either change the default in System Settings → Default Applications, or re-run the installer with `--app-window <id> --change-address` (or `--browser-tab --change-address` to go back), and have them **Open** the saved file in the new browser.

## About the colors

Hex values for MARD colors are community-sourced approximations (see `README.md`); screens and photos vary. For close calls, compare against a physical MARD color card.
