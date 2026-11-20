#!/usr/bin/env bash
# WhatsOps for Linux — installs (or updates) WhatsOps for the current user:
#
#   curl -fsSL https://raw.githubusercontent.com/emrgim/WhatsOps/main/install/linux.sh | bash
#
# - downloads the latest release for this system (x64 or arm64), checks its SHA-256,
#   unpacks it in ~/.local/share/mcp-mrg-whatsops/runtime/<version>  (Node included: nothing else to install)
# - runs it as a systemd user service (whatsops.service): starts at login, restarts by itself;
#   later versions are installed by WhatsOps itself (Settings → Updates)
# - adds "WhatsOps" to the applications menu and opens it in the browser, already signed in
#
# Options (environment): WA_PORT (default 8810), WHATSOPS_ARCHIVE=<file> (install from a downloaded
# runtime archive), WHATSOPS_NO_BROWSER=1, WHATSOPS_NO_SERVICE=1 (do not create the systemd service).
# Uninstall: bash linux.sh --uninstall   (add --purge to delete data too: WhatsApp sessions, messages)
set -euo pipefail

REPO="${WHATSOPS_REPO:-emrgim/WhatsOps}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/mcp-mrg-whatsops"
RT="$DATA/runtime"
PORT="${WA_PORT:-8810}"
UNIT="whatsops.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'WhatsOps: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$UNIT" "$APPS/whatsops.desktop" "$ICONS/whatsops.png"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -rf "$RT"
  [ "${2:-}" = "--purge" ] && rm -rf "$DATA"
  say "WhatsOps removed${2:+ (data deleted)}."
  exit 0
fi

need curl
need tar
need sha256sum
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "this processor ($(uname -m)) is not supported: x64 or arm64 only" ;;
esac
if [ -z "${WHATSOPS_NO_SERVICE:-}" ]; then
  need systemctl
  systemctl --user is-active --quiet mcp-mrg-whatsops.service 2>/dev/null &&
    die "WhatsOps already runs here from a git install (mcp-mrg-whatsops.service): stop it before installing the package"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -n "${WHATSOPS_ARCHIVE:-}" ]; then
  NAME="$(basename "$WHATSOPS_ARCHIVE")"
  VER="$(printf '%s' "$NAME" | sed -n 's/^whatsops-\([0-9][0-9.]*\)-runtime-.*/\1/p')"
  [ -n "$VER" ] || die "$NAME is not a WhatsOps runtime archive"
  cp "$WHATSOPS_ARCHIVE" "$TMP/$NAME"
  [ -f "$WHATSOPS_ARCHIVE.sha256" ] && cp "$WHATSOPS_ARCHIVE.sha256" "$TMP/$NAME.sha256"
else
  # latest release: github.com/<repo>/releases/latest redirects to its tag
  TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  TAG="${TAG##*/}"
  VER="${TAG#v}"
  [ -n "$VER" ] && [ "$VER" != latest ] || die "no release found on github.com/$REPO"
  NAME="whatsops-$VER-runtime-linux-$ARCH.tar.gz"
  say "Downloading WhatsOps $VER ($ARCH)…"
  curl -fL --retry 3 --progress-bar -o "$TMP/$NAME" "https://github.com/$REPO/releases/download/$TAG/$NAME" ||
    die "the package for linux-$ARCH of version $VER is not published yet: try again in a few minutes"
  curl -fsSL --retry 3 -o "$TMP/$NAME.sha256" "https://github.com/$REPO/releases/download/$TAG/$NAME.sha256"
fi
if [ -f "$TMP/$NAME.sha256" ]; then
  (cd "$TMP" && sha256sum -c --quiet "$NAME.sha256") || die "the download does not match its SHA-256"
fi

umask 077
mkdir -p "$RT"
chmod 700 "$DATA"
CUR="$(cat "$RT/current" 2>/dev/null || true)"
rm -rf "$RT/$VER.part"
mkdir -p "$RT/$VER.part"
tar -xzf "$TMP/$NAME" -C "$RT/$VER.part"
[ -x "$RT/$VER.part/node/bin/node" ] && [ -f "$RT/$VER.part/app/dist/main.js" ] || die "the package is incomplete"
if [ "$CUR" = "$VER" ] && [ -z "${WHATSOPS_NO_SERVICE:-}" ]; then systemctl --user stop "$UNIT" 2>/dev/null || true; fi
rm -rf "${RT:?}/$VER"
mv "$RT/$VER.part" "$RT/$VER"
if [ -n "$CUR" ] && [ "$CUR" != "$VER" ]; then printf '%s' "$CUR" >"$RT/previous"; fi
printf '%s' "$VER" >"$RT/current.tmp" && mv "$RT/current.tmp" "$RT/current"

# the service runs this wrapper: always the current version (the updater switches it)
cat >"$RT/run.sh" <<'EOF'
#!/usr/bin/env bash
RT="$(cd "$(dirname "$0")" && pwd)"
V="$(cat "$RT/current")"
export WA_RUNTIME_DIR="$RT" WA_SUPERVISED=1
exec "$RT/$V/node/bin/node" "$RT/$V/app/dist/main.js"
EOF
# "WhatsOps" in the applications menu: opens the page already signed in
cat >"$RT/open.sh" <<EOF
#!/usr/bin/env bash
RT="\$(cd "\$(dirname "\$0")" && pwd)"
V="\$(cat "\$RT/current")"
for _ in \$(seq 1 60); do curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
URL="\$(WA_PORT=$PORT "\$RT/\$V/node/bin/node" "\$RT/\$V/app/dist/cli.js" login-link --local --minutes 2 | tail -1)"
if command -v omarchy-launch-webapp >/dev/null 2>&1; then exec omarchy-launch-webapp "\$URL"; fi
exec xdg-open "\$URL"
EOF
chmod 700 "$RT/run.sh" "$RT/open.sh"

mkdir -p "$APPS" "$ICONS"
cp "$RT/$VER/app/packaging/icons/WhatsOps-256.png" "$ICONS/whatsops.png"
cat >"$APPS/whatsops.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=WhatsOps
Comment=WhatsApp server: numbers, MCP, API, plugins
Exec=$RT/open.sh
Icon=whatsops
Terminal=false
Categories=Network;Chat;
StartupNotify=false
EOF
chmod 644 "$APPS/whatsops.desktop" "$ICONS/whatsops.png"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true

if [ -z "${WHATSOPS_NO_SERVICE:-}" ]; then
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=WhatsOps (WhatsApp server: MCP, REST API, plugins)
After=network-online.target

[Service]
ExecStart=$RT/run.sh
Environment=WA_HOST=127.0.0.1
Environment=WA_PORT=$PORT
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1
  systemctl --user restart "$UNIT"
else
  # no service: start it in the background for this session only
  (WA_HOST=127.0.0.1 WA_PORT="$PORT" nohup "$RT/run.sh" >>"$DATA/run.log" 2>&1 &)
fi

for _ in $(seq 1 120); do
  curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || die "WhatsOps did not start: journalctl --user -u $UNIT"
say "WhatsOps $VER is running on http://127.0.0.1:$PORT"
if [ -z "${WHATSOPS_NO_BROWSER:-}" ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
  "$RT/open.sh" >/dev/null 2>&1 &
else
  echo "Sign in: $(WA_PORT=$PORT "$RT/$VER/node/bin/node" "$RT/$VER/app/dist/cli.js" login-link --local --minutes 30 | tail -1)"
fi
