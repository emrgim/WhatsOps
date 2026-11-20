#!/bin/bash
# WhatsOps.app — first launch installs WhatsOps for this user, every launch opens its page.
#
#  - copies the runtime inside the app (Node + WhatsOps) to ~/Library/Application Support/mcp-mrg-whatsops/runtime/<version>
#    when it is newer than the installed one (the auto-update installs newer versions there by itself);
#  - registers a LaunchAgent (im.mrg.whatsops) that keeps WhatsOps running in the background and starts it at login;
#  - opens http://127.0.0.1:8810 already signed in (one-time link).
set -u

RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
SEED="$RES/runtime"
DATA="$HOME/Library/Application Support/mcp-mrg-whatsops"
RT="$DATA/runtime"
LOGS="$DATA/logs"
LABEL="im.mrg.whatsops"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${WA_PORT:-8810}"
DOMAIN="gui/$(id -u)"

alert() { /usr/bin/osascript -e "display alert \"WhatsOps\" message \"$1\"" >/dev/null 2>&1 || echo "$1" >&2; }
# is version $1 newer than $2 (x.y.z)?
newer() {
  local IFS=. a b i
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    [ "${a[i]:-0}" -gt "${b[i]:-0}" ] && return 0
    [ "${a[i]:-0}" -lt "${b[i]:-0}" ] && return 1
  done
  return 1
}

umask 077
mkdir -p "$RT" "$LOGS" "$HOME/Library/LaunchAgents"
chmod 700 "$DATA"

VER="$(cat "$SEED/VERSION")"
CUR="$(cat "$RT/current" 2>/dev/null || true)"
CHANGED=0
if [ -z "$CUR" ] || [ ! -x "$RT/$CUR/node/bin/node" ] || newer "$VER" "$CUR"; then
  rm -rf "$RT/$VER.part"
  if ! /usr/bin/ditto "$SEED" "$RT/$VER.part"; then
    alert "WhatsOps could not be installed in $RT."
    exit 1
  fi
  rm -f "$RT/$VER.part/VERSION"
  # the copy must not carry the download quarantine: Node would refuse its native modules
  /usr/bin/xattr -dr com.apple.quarantine "$RT/$VER.part" 2>/dev/null || true
  rm -rf "$RT/$VER" && mv "$RT/$VER.part" "$RT/$VER"
  if [ -n "$CUR" ] && [ "$CUR" != "$VER" ]; then printf '%s' "$CUR" >"$RT/previous"; fi
  printf '%s' "$VER" >"$RT/current.tmp" && mv "$RT/current.tmp" "$RT/current"
  CHANGED=1
fi

# launchd runs this wrapper: always the current version (the updater switches it)
cat >"$RT/run.sh" <<'EOF'
#!/bin/bash
RT="$(cd "$(dirname "$0")" && pwd)"
V="$(cat "$RT/current")"
export WA_RUNTIME_DIR="$RT" WA_SUPERVISED=1
exec "$RT/$V/node/bin/node" "$RT/$V/app/dist/main.js"
EOF
chmod 700 "$RT/run.sh"

cat >"$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$RT/run.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>WA_HOST</key><string>127.0.0.1</string><key>WA_PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$LOGS/launchd.log</string>
  <key>StandardErrorPath</key><string>$LOGS/launchd.log</string>
</dict>
</plist>
EOF

if ! cmp -s "$PLIST.tmp" "$PLIST"; then
  mv "$PLIST.tmp" "$PLIST"
  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  /bin/launchctl bootstrap "$DOMAIN" "$PLIST"
else
  rm -f "$PLIST.tmp"
  if ! /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    /bin/launchctl bootstrap "$DOMAIN" "$PLIST"
  elif [ "$CHANGED" = 1 ]; then
    /bin/launchctl kickstart -k "$DOMAIN/$LABEL"
  fi
fi

# wait for the page (first start: up to a minute)
for _ in $(seq 1 120); do
  /usr/bin/curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done

V="$(cat "$RT/current")"
URL="$(WA_PORT="$PORT" "$RT/$V/node/bin/node" "$RT/$V/app/dist/cli.js" login-link --local --minutes 2 2>>"$LOGS/launchd.log" | tail -1)"
if [ -n "${WHATSOPS_NO_BROWSER:-}" ]; then
  echo "$URL"
  exit 0
fi
case "$URL" in
  http*) /usr/bin/open "$URL" ;;
  *)
    alert "WhatsOps did not start. Log: $LOGS"
    /usr/bin/open "http://127.0.0.1:$PORT/"
    ;;
esac
