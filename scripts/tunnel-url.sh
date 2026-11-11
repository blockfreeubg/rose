#!/usr/bin/env bash
# Print Rose's public link from the cloudflared quick tunnel (scripts/rose-tunnel.service). It is a new
# random https://*.trycloudflare.com address every time the tunnel starts (boot, restart).
set -uo pipefail
find_url() { "$@" journalctl -u rose-tunnel -b --no-pager -o cat 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1; }
url=$(find_url)
# Reading a system service's log may need your admin password (unless you're in the wheel group).
[ -z "$url" ] && url=$(find_url sudo)
if [ -n "$url" ]; then
  echo "$url"
else
  echo "No tunnel link yet. Is the tunnel running?  systemctl status rose-tunnel" >&2
  exit 1
fi
