#!/usr/bin/env bash
# WhatsOps for Omarchy — installs (or updates) WhatsOps for the current user:
#
#   curl -fsSL https://raw.githubusercontent.com/emrgim/WhatsOps/main/install/omarchy.sh | bash
#
# Same as the Linux install (systemd user service, auto-update), and "WhatsOps" opens as an
# Omarchy web app (its own window, in the app launcher). The page follows the Omarchy theme
# when Settings → Appearance is "System".
set -euo pipefail
REPO="${WHATSOPS_REPO:-emrgim/WhatsOps}"
command -v omarchy-launch-webapp >/dev/null 2>&1 || echo "WhatsOps: omarchy-launch-webapp not found, the browser will be used instead" >&2
SRC="${BASH_SOURCE[0]:-}"
if [ -n "$SRC" ] && [ -f "$SRC" ] && [ -f "$(dirname "$SRC")/linux.sh" ]; then
  exec bash "$(dirname "$SRC")/linux.sh" "$@"
fi
curl -fsSL "https://raw.githubusercontent.com/$REPO/main/install/linux.sh" | bash -s -- "$@"
