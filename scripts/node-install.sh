#!/usr/bin/env bash
# Rose node installer: turns this Linux machine into a Rose node, which runs game sessions for a
# Rose hub (the main server) on this machine's CPU, RAM and GPU. The node dials out to the hub, so
# no ports need to be opened. Served by the hub at /node/install.sh; the hub's Hosts page shows:
#
#   curl -fsSL https://<hub>/node/install.sh | bash -s -- --hub https://<hub> --token rn_...
#
# Options:
#   --hub URL        the hub's address (https://...)
#   --token TOKEN    the join token the hub owner gave you (rn_...)
#   --dir DIR        where to install (default ~/rose-node); rerun to update
#   --max N          sessions at once (default: auto, sized from this machine)
#   --insecure       allow a plain http:// hub on a public address (not recommended)
#   --gpu MODE       auto (default: use /dev/dri if there is one), host, or guest (render on the CPU)
#   --uninstall      stop the node and remove its containers, images, volumes and DIR
#
# The token can also come from the ROSE_NODE_TOKEN environment variable (keeps it out of ps).
# Windows and macOS hosts use node-install.ps1 / node-install-mac.sh instead, which run this script
# inside a small Ubuntu VM (scripts/vm/cloud-init.yaml); there arm64 (Apple Silicon) is fine too.
#
# Needs: Linux x86_64 (or arm64), Docker with the compose plugin, and binder in the kernel (binderfs, or the
# binder_linux module). Sessions are privileged Android containers started through Docker: only
# join hubs you trust.
set -euo pipefail

HUB="" TOKEN="${ROSE_NODE_TOKEN:-}" DIR="$HOME/rose-node" MAX="auto" INSECURE=0 UNINSTALL=0 GPU_WANT=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --max) MAX="${2:-}"; shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    --gpu) GPU_WANT="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,26p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;31m==\033[0m %s\n' "$*"; }
ok() { printf '   \033[32mOK\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# Docker, as this user or through sudo.
DOCKER="docker"
pick_docker() {
  command -v docker >/dev/null || die "Docker is not installed. Install Docker Engine + the compose plugin (https://docs.docker.com/engine/install/), then rerun."
  if docker info >/dev/null 2>&1; then DOCKER="docker"
  elif sudo -n true 2>/dev/null || [ -t 0 ] || [ -e /dev/tty ]; then
    sudo docker info >/dev/null 2>&1 || die "Docker is installed but not running (try: sudo systemctl enable --now docker)."
    DOCKER="sudo docker"
    warn "using sudo for docker (add yourself to the docker group to avoid that)"
  else
    die "cannot reach Docker (permission denied?)."
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  pick_docker
  say "Removing the Rose node in $DIR"
  if [ -f "$DIR/docker-compose.node.yml" ]; then
    (cd "$DIR" && $DOCKER compose -f docker-compose.node.yml down -v --rmi local) || true
  fi
  # Session containers it may have left behind (only this instance's label).
  ids=$($DOCKER ps -aq --filter label=rose.instance=node || true)
  [ -n "$ids" ] && $DOCKER rm -f $ids >/dev/null || true
  $DOCKER network rm rose-node >/dev/null 2>&1 || true
  case "$DIR" in /|"$HOME"|"") die "refusing to delete $DIR" ;; esac
  rm -rf "$DIR"
  ok "removed. (The redroid image stays: docker rmi redroid/redroid:12.0.0_64only-latest)"
  exit 0
fi

[ -n "$HUB" ] || die "missing --hub (the hub's address, e.g. https://rose.example.com)"
[ -n "$TOKEN" ] || die "missing --token (ask the hub owner for a join token)"
HUB="${HUB%/}"
# It goes into .env and into commands printed for copy-paste: a plain address only.
[[ "$HUB" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] || die "--hub must be a plain address like https://rose.example.com"
[[ "$TOKEN" =~ ^rn_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$ ]] || die "that token does not look right (it starts with rn_)."
[[ "$MAX" =~ ^(auto|[0-9]+)$ ]] || die "--max must be a number or auto"
[[ "$GPU_WANT" =~ ^(auto|host|guest)$ ]] || die "--gpu must be auto, host or guest"

say "Checking this machine"
[ "$(uname -s)" = Linux ] || die "Rose nodes run on Linux only (Windows/macOS are not supported natively)."
case "$(uname -m)" in
  x86_64) ok "Linux x86_64 ($(uname -r))" ;;
  aarch64|arm64) ok "Linux arm64 ($(uname -r))"
    warn "arm64: ARM Android games run natively; x86-only apps and Switch homebrew are not sent to this node." ;;
  *) die "Rose nodes need an x86_64 (amd64) or arm64 machine; this is $(uname -m)." ;;
esac
if grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null; then
  warn "WSL2 detected: its stock kernel has no binder. You need a custom WSL kernel with binder (CONFIG_ANDROID_BINDERFS)."
fi

# The hub's address: https, unless it's on this network (or --insecure).
proto="${HUB%%://*}" hosthp="${HUB#*://}"; host="${hosthp%%[/:]*}"
case "$proto" in https) ;; http)
  if [ "$INSECURE" != 1 ] && ! [[ "$host" =~ ^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)|^[^.]+$|\.(local|lan|internal)$ ]]; then
    die "the hub address is plain http:// on the internet: use its https:// address (or pass --insecure)."
  fi
  [[ "$host" =~ ^(localhost|127\.) ]] && warn "the hub is \"$host\": inside the node's container that means the container itself. Use the hub's LAN address instead."
  ;; *) die "--hub must start with https://" ;;
esac
ok "hub $HUB"

pick_docker
$DOCKER compose version >/dev/null 2>&1 || die "the Docker compose plugin is missing (package docker-compose-plugin / docker-compose)."
ok "docker $($DOCKER version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose $($DOCKER compose version --short 2>/dev/null || echo '?')"

# Android needs binder: binderfs in the kernel, or the binder_linux module.
binder_ok() { grep -qw binder /proc/filesystems 2>/dev/null || [ -d /sys/module/binder_linux ] || [ -e /dev/binder ]; }
if binder_ok; then
  ok "binder"
elif zcat /proc/config.gz 2>/dev/null | grep -q 'CONFIG_ANDROID_BINDERFS=y'; then
  ok "binderfs built into the kernel"
elif sudo modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null; then
  echo 'binder_linux' | sudo tee /etc/modules-load.d/redroid.conf >/dev/null
  echo 'options binder_linux devices=binder,hwbinder,vndbinder' | sudo tee /etc/modprobe.d/redroid.conf >/dev/null
  ok "loaded binder_linux (and at every boot)"
else
  die "this kernel has no binder support, which Android needs. Options: install your distro's extra kernel modules
   (Ubuntu/Debian: sudo apt install linux-modules-extra-\$(uname -r)), binder_linux-dkms, or a kernel with
   CONFIG_ANDROID_BINDERFS=y (e.g. linux-zen, xanmod). Many VPS kernels can't load modules: pick a KVM VPS."
fi
if [ -e /dev/uhid ] || [ -d /sys/module/uhid ]; then
  ok "uhid (controllers in console emulators)"
elif sudo modprobe uhid 2>/dev/null; then
  echo 'uhid' | sudo tee /etc/modules-load.d/rose-uhid.conf >/dev/null 2>&1 || true
  ok "loaded uhid (controllers in console emulators), and at every boot"
else
  warn "no uhid: console games (Switch homebrew) won't be sent to this node; Android games still work."
fi

ram_mb=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
threads=$(nproc)
[ "$ram_mb" -ge 4096 ] || die "this machine has $((ram_mb / 1024)) GB RAM; a node needs at least 4 GB (about 2.5 GB per session plus 2 GB for the system)."
ok "$threads threads, $((ram_mb / 1024)) GB RAM"
if [ "$GPU_WANT" = guest ]; then GPU=guest; ok "GPU off (--gpu guest): sessions render on the CPU"
elif [ "$GPU_WANT" = host ] || ls /dev/dri/renderD* >/dev/null 2>&1; then GPU=host; ok "GPU (/dev/dri): sessions use it"
else GPU=guest; warn "no GPU found: sessions render on the CPU (slower)"; fi
mkdir -p "$DIR"
# The Android image, sessions and the game cache live in Docker's data directory, not in DIR.
droot=$($DOCKER info -f '{{.DockerRootDir}}' 2>/dev/null || true)
[ -n "$droot" ] && df -Pk "$droot" >/dev/null 2>&1 || droot="$DIR"
free_gb=$(( $(df -Pk "$droot" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
[ "$free_gb" -ge 10 ] || die "only $free_gb GB free disk for Docker ($droot); a node needs 20 GB or more."
[ "$free_gb" -ge 20 ] || warn "only $free_gb GB free disk for Docker ($droot); 20 GB or more is recommended."
ok "$free_gb GB free disk for Docker"

say "Downloading the node from the hub"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$work/auth"          # not on the command line (ps)
code=$(curl -sS --proto '=https,http' -H @"$work/auth" -D "$work/headers" -o "$work/bundle.tgz" -w '%{http_code}' "$HUB/node/bundle.tgz" || true)
case "$code" in
  200) ;;
  401) die "the hub refused the token (revoked, or mistyped). Ask the hub owner for a new one." ;;
  429) die "the hub locked this address out after too many wrong tokens; try again in 10 minutes." ;;
  000) die "could not reach $HUB." ;;
  *) die "the hub answered HTTP $code for the node bundle." ;;
esac
bundle_sha=$(awk 'tolower($1)=="x-rose-bundle-sha256:" {print $2}' "$work/headers" | tr -d '\r' | tail -n1)
got_sha=$(sha256sum "$work/bundle.tgz" | cut -d' ' -f1)
[ -z "$bundle_sha" ] || [ "$bundle_sha" = "$got_sha" ] || die "the download is corrupt (checksum mismatch); try again."
# Only the files a node needs, and no absolute or ../ paths.
tar -tzf "$work/bundle.tgz" > "$work/list"
if grep -vqE '^(\./)?(Dockerfile|package\.json|package-lock\.json|docker-compose\.node\.yml|server(/.*)?|public(/.*)?)$' "$work/list"; then
  die "unexpected files in the node bundle; not installing it."
fi
if grep -qE '(^/|(^|/)\.\.(/|$))' "$work/list"; then die "unsafe paths in the node bundle; not installing it."; fi
umask 022
rm -rf "$DIR/server" "$DIR/public"
tar -xzf "$work/bundle.tgz" --no-same-owner -C "$DIR"
ok "installed into $DIR"

umask 077
cat > "$DIR/.env" <<EOF
# Rose node settings (written by node-install.sh). Keep this file private: it holds the join token.
ROSE_HUB_URL=$HUB
ROSE_NODE_TOKEN=$TOKEN
ROSE_HUB_INSECURE=$INSECURE
ROSE_BUNDLE_SHA256=$got_sha
GPU_MODE=$GPU
MAX_SESSIONS=$MAX
# NODE_ALLOW_UPLOADS=1   # let players install their own apps/files on this machine (off by default)
EOF
chmod 600 "$DIR/.env"
umask 022
ok "wrote $DIR/.env"

say "Pulling Android and building the node (a few minutes the first time)"
$DOCKER pull redroid/redroid:12.0.0_64only-latest
cd "$DIR"
$DOCKER compose -f docker-compose.node.yml up -d --build

say "Connecting to the hub"
for _ in $(seq 1 60); do
  logs=$($DOCKER logs rose-node 2>&1 || true)   # (not piped into grep -q: with pipefail that can fail on SIGPIPE)
  if grep -q 'connected to hub as' <<<"$logs"; then
    ok "$(grep 'connected to hub as' <<<"$logs" | tail -n1 | sed 's/^[^ ]* node: //')"
    cat <<EOF

Your machine is now a Rose node. Players the hub sends here run on this computer.
  Status:     docker logs -f rose-node
  Stop:       cd $DIR && $DOCKER compose -f docker-compose.node.yml down
  Start:      cd $DIR && $DOCKER compose -f docker-compose.node.yml up -d
  Update:     rerun the install command
  Uninstall:  curl -fsSL $HUB/node/install.sh | bash -s -- --uninstall --dir $DIR
EOF
    exit 0
  fi
  if grep -qE 'cannot start:|token revoked' <<<"$logs"; then break; fi
  sleep 2
done
$DOCKER logs --tail 30 rose-node 2>&1 || true
die "the node did not connect yet; see the log above (docker logs -f rose-node)."
