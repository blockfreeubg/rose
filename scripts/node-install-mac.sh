#!/bin/bash
# Rose node installer for macOS (Intel and Apple Silicon). Android (redroid) needs a Linux kernel
# with binder, so the node runs inside a small Ubuntu VM made with Canonical Multipass; inside it,
# the hub's normal Linux node installer runs (scripts/vm/cloud-init.yaml). Served by the hub at
# /node/install-mac.sh; the hub's Hosts page shows:
#
#   curl -fsSL https://<hub>/node/install-mac.sh | ROSE_NODE_TOKEN=rn_... bash -s -- --hub https://<hub>
#
# (The token goes in the environment, not the arguments, which ps shows to every user. --token works too.)
#
# Options:
#   --hub URL        the hub's address (https://...)
#   --token TOKEN    the join token the hub owner gave you (rn_...; or set ROSE_NODE_TOKEN)
#   --cpus N         VM CPUs     (default: all threads but 2, at least 3)
#   --memory GB      VM RAM      (default: half this Mac's RAM, leaving at least 4 GB to macOS; min 5)
#   --disk GB        VM disk     (default 30, min 20)
#   --max N          sessions at once (default: auto, sized from the VM)
#   --name NAME      Multipass VM name (default rose-node)
#   --insecure       allow a plain http:// hub on a public address (not recommended)
#   --yes            don't ask before installing Multipass
#   --uninstall      delete the VM (and everything in it). Multipass itself stays.
#
# Rerun with the VM in place to update the node (with --token: switch to a new token; with
# --cpus/--memory/--disk: resize the VM, which restarts it).
# No GPU acceleration in the VM: games render on the CPU. On Apple Silicon the VM is arm64: ARM
# Android games run natively, x86-only apps and Switch homebrew are not sent to this node.
# Sessions are privileged Android containers started by code from the hub: only join hubs you trust.
# Works with the bash 3.2 that ships with macOS.
set -eu
# The whole script is one { } block, so bash has read all of it before running anything: with
# "curl | bash" the script IS stdin, and a command that reads stdin (multipass exec forwards it)
# would otherwise swallow the rest of the script.
{

HUB="" TOKEN="${ROSE_NODE_TOKEN:-}" CPUS="" MEM="" DISK="" MAX="auto" NAME="rose-node" INSECURE=0 YES=0 UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --cpus) CPUS="${2:-}"; shift 2 ;;
    --memory) MEM="${2:-}"; MEM="${MEM%[Gg]}"; shift 2 ;;
    --disk) DISK="${2:-}"; DISK="${DISK%[Gg]}"; shift 2 ;;
    --max) MAX="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,31p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
unset ROSE_NODE_TOKEN

say() { printf '\033[1;31m==\033[0m %s\n' "$*"; }
ok() { printf '   \033[32mOK\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }
mask() { case "$1" in rn_????????_*) printf 'rn_%s_****%s' "$(printf '%s' "$1" | cut -c4-11)" "$(printf '%s' "$1" | tail -c 4)" ;; *) printf '****' ;; esac; }
isnum() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
# Questions come from the terminal: stdin is this script when run through "curl | bash".
ask() {
  [ "$YES" = 1 ] && return 0
  [ -r /dev/tty ] || die "$1 (rerun with --yes to answer yes)"
  printf '%s [Y/n] ' "$1" > /dev/tty
  read -r a < /dev/tty || a=n
  case "$a" in ''|[Yy]*) return 0 ;; *) return 1 ;; esac
}

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS. On Linux use: curl -fsSL <hub>/node/install.sh | bash -s -- ..."
case "$NAME" in ''|*[!A-Za-z0-9-]*) die "--name may only use letters, digits and -" ;; esac

MP=""
find_mp() {
  MP=""
  if command -v multipass >/dev/null 2>&1; then MP=$(command -v multipass)
  elif [ -x /usr/local/bin/multipass ]; then MP=/usr/local/bin/multipass
  elif [ -x /opt/homebrew/bin/multipass ]; then MP=/opt/homebrew/bin/multipass
  fi
  [ -n "$MP" ]
}
vm_exists() { "$MP" info "$NAME" >/dev/null 2>&1 </dev/null; }
# Commands in the VM, with no stdin (see the top).
vmx() { "$MP" exec "$NAME" -- sudo "$@" </dev/null; }

if [ "$UNINSTALL" = 1 ]; then
  find_mp || die "Multipass is not installed, so there is no Rose node VM to remove."
  if vm_exists; then
    say "Deleting the VM $NAME (its sessions end)"
    "$MP" stop "$NAME" >/dev/null 2>&1 || true
    "$MP" delete --purge "$NAME"
    ok "removed. Ask the hub owner to revoke this host's token."
    echo "   Multipass itself stays: brew uninstall --cask multipass, or sudo sh \"/Library/Application Support/com.canonical.multipass/uninstall.sh\""
  else
    ok "there is no VM called $NAME."
  fi
  exit 0
fi

[ -n "$HUB" ] || die "missing --hub (the hub's address, e.g. https://rose.example.com)"
HUB="${HUB%/}"
URL_RE='^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'
TOKEN_RE='^rn_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$'
[[ $HUB =~ $URL_RE ]] || die "--hub does not look like an address (https://host[:port][/path])."
if [ -n "$TOKEN" ]; then [[ $TOKEN =~ $TOKEN_RE ]] || die "that token does not look right (it starts with rn_)."; fi
isnum "$MAX" || [ "$MAX" = auto ] || die "--max must be a number or auto"
for v in "$CPUS" "$MEM" "$DISK"; do [ -z "$v" ] || isnum "$v" || die "--cpus/--memory/--disk take whole numbers (GB for memory and disk)"; done

# Sizes given on the command line (for an existing VM only these are applied).
SET_CPUS=$CPUS SET_MEM=$MEM SET_DISK=$DISK

say "Checking this Mac"
osv=$(sw_vers -productVersion 2>/dev/null || echo 0)
osmaj=${osv%%.*}
isnum "$osmaj" || osmaj=0
[ "$osmaj" -ge 13 ] || die "macOS $osv is too old: Multipass needs macOS 13 Ventura or later (14 Sonoma or later for current releases)."
[ "$osmaj" -ge 14 ] || warn "macOS $osv: current Multipass releases need macOS 14 Sonoma or later; an older Multipass may be used."
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
  ARCH=arm64
  ok "macOS $osv, Apple Silicon: the VM is arm64 (ARM Android games run natively; no x86-only apps or Switch homebrew)"
else
  ARCH=x86_64
  ok "macOS $osv, Intel: the VM is x86_64"
  [ "$(sysctl -n kern.hv_support 2>/dev/null || echo 0)" = 1 ] || die "this Mac has no hardware virtualization (kern.hv_support=0), which the VM needs."
fi
ram_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
threads=$(sysctl -n hw.ncpu)
ok "$threads threads, $ram_gb GB RAM"

# VM size: half the RAM (capped at 32 GB) but leave macOS at least 4 GB; all threads but 2 (min 3).
if [ -z "$MEM" ]; then
  MEM=$(( ram_gb / 2 )); [ "$MEM" -ge 5 ] || MEM=5
  [ $(( ram_gb - MEM )) -ge 4 ] || MEM=$(( ram_gb - 4 ))
  [ "$MEM" -le 32 ] || MEM=32
  [ "$MEM" -ge 5 ] || die "this Mac has $ram_gb GB RAM; a node VM needs 5 GB and macOS needs 4 GB more (9 GB or more). Force a size with --memory 5."
fi
[ "$MEM" -ge 5 ] || die "--memory must be 5 (GB) or more: one session needs about 2.5 GB plus 2 GB for the VM."
[ $(( ram_gb - MEM )) -ge 3 ] || warn "only $(( ram_gb - MEM )) GB RAM left for macOS while the VM runs."
if [ -z "$CPUS" ]; then
  CPUS=$(( threads - 2 )); [ "$CPUS" -ge 3 ] || CPUS=3
  [ "$CPUS" -le "$threads" ] || CPUS=$threads
  [ "$CPUS" -le 16 ] || CPUS=16
fi
[ "$CPUS" -ge 3 ] || die "the VM needs 3 or more CPUs (one session uses 2, plus 1 for the VM)."
[ -n "$DISK" ] || DISK=30
[ "$DISK" -ge 20 ] || die "--disk must be 20 (GB) or more."
# The node sizes itself (MAX_SESSIONS=auto): about 2.5 GB and 2 CPUs per session, after 2 GB and 1 CPU.
by_ram=$(( (MEM * 1024 - 250 - 2048) / 2560 )); by_cpu=$(( (CPUS - 1) / 2 ))
slots=$by_ram; [ "$by_cpu" -ge "$slots" ] || slots=$by_cpu
isnum "$MAX" && slots=$MAX
ok "VM: $CPUS CPUs, $MEM GB RAM, $DISK GB disk: about $slots session(s) at once (CPU rendering, no GPU)"
free_gb=$(( $(df -Pk "$HOME" | awk 'NR==2 {print $4}') / 1048576 ))
[ "$free_gb" -ge "$DISK" ] || warn "only $free_gb GB free disk; the VM can grow to $DISK GB."

# The hub's address: https, unless it's on this network (or --insecure).
proto="${HUB%%://*}" hosthp="${HUB#*://}"; host="${hosthp%%[/:]*}"
PRIV_RE='^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)|^[^.]+$|\.(local|lan|internal)$'
case "$host" in localhost|127.*) die "the hub is \"$host\": inside the VM that means the VM itself. Use the hub's LAN address or its https:// address." ;; esac
if [ "$proto" = http ] && [ "$INSECURE" != 1 ] && ! [[ $host =~ $PRIV_RE ]]; then
  die "the hub address is plain http:// on the internet: use its https:// address (or pass --insecure)."
fi
curl -fsS -o /dev/null --max-time 20 "$HUB/node/install.sh" || die "could not reach $HUB (or it is not a Rose hub with node support)."
ok "hub $HUB"

# ---------------------------------------------------------------- Multipass
if ! find_mp; then
  say "Installing Multipass (Canonical's Ubuntu VM manager)"
  [ "$osmaj" -ge 14 ] || die "current Multipass needs macOS 14 Sonoma or later. On macOS $osv install an older release (1.16 or earlier) from https://github.com/canonical/multipass/releases, then rerun."
  ask "Multipass is not installed. Install it now (needs your password)?" || die "Multipass is needed: https://canonical.com/multipass/install"
  if command -v brew >/dev/null 2>&1; then
    brew install --cask multipass
  else
    pkgurl=$(curl -fsSL https://api.github.com/repos/canonical/multipass/releases/latest \
      | grep -o '"browser_download_url": *"[^"]*Darwin\.pkg"' | head -n1 | sed 's/.*"\(https[^"]*\)"$/\1/')
    [ -n "$pkgurl" ] || die "could not find the Multipass installer; get it from https://canonical.com/multipass/install"
    tmpd=$(mktemp -d)
    echo "   downloading $pkgurl"
    curl -fL --progress-bar -o "$tmpd/multipass.pkg" "$pkgurl"
    sudo installer -pkg "$tmpd/multipass.pkg" -target / </dev/tty
    rm -rf "$tmpd"
  fi
  find_mp || die "Multipass did not install; get it from https://canonical.com/multipass/install"
  # The daemon needs a moment after a fresh install.
  i=0; until "$MP" version >/dev/null 2>&1 || [ $i -ge 30 ]; do sleep 2; i=$((i + 1)); done
fi
mpver=$("$MP" version 2>/dev/null | awk '/^multipass /{print $2; exit}')
ok "multipass ${mpver:-?} ($MP)"
MPN=$MP; [ "$(command -v multipass 2>/dev/null)" = "$MP" ] && MPN=multipass   # for the commands printed below

status() { vmx /usr/local/sbin/rose-node-status 2>/dev/null | tail -n1 | grep . || echo "starting waiting for the VM"; }
wait_online() {
  say "Waiting for the node to connect (the first start takes 5 to 15 minutes)"
  last="" t0=$(date +%s)
  while :; do
    s=$(status)
    [ "$s" = "$last" ] || { echo "   ${s#starting }"; last="$s"; }
    case "$s" in
      online*) ok "${s#online }"; return 0 ;;
      refused) die "the hub refused the token (revoked, or mistyped). Ask the hub owner for a new one and rerun with --token." ;;
      failed*) vmx tail -n 20 /var/log/rose-node-install.log 2>/dev/null || true; die "the node failed: ${s#failed }" ;;
    esac
    [ $(( $(date +%s) - t0 )) -lt 1800 ] || die "the node did not come online in 30 minutes. Look inside: $MP shell $NAME, then: sudo tail -f /var/log/rose-node-install.log"
    sleep 10
  done
}
UNNAME=""; [ "$NAME" = rose-node ] || UNNAME=" --name $NAME"
done_msg() {
  cat <<EOF

This Mac now runs a Rose node in the VM "$NAME". Players the hub sends here run on this computer.
  Status:     $MPN exec $NAME -- sudo /usr/local/sbin/rose-node-status
  Logs:       $MPN exec $NAME -- sudo docker logs -f rose-node
  Stop:       $MPN stop $NAME        (frees its RAM; its sessions end)
  Start:      $MPN start $NAME
  Update:     rerun the install command
  Uninstall:  curl -fsSL $HUB/node/install-mac.sh | bash -s -- --uninstall$UNNAME
EOF
}

# ---------------------------------------------------------------- existing VM: update (and resize)
if vm_exists; then
  say "The VM $NAME exists: updating it"
  if [ -n "$SET_CPUS$SET_MEM$SET_DISK" ]; then
    echo "   resizing (restarts the VM; its sessions end)"
    "$MP" stop "$NAME" </dev/null || true
    [ -z "$SET_CPUS" ] || "$MP" set "local.$NAME.cpus=$SET_CPUS"
    [ -z "$SET_MEM" ] || "$MP" set "local.$NAME.memory=${SET_MEM}G"
    [ -z "$SET_DISK" ] || "$MP" set "local.$NAME.disk=${SET_DISK}G" || warn "the disk can only grow, not shrink"
  fi
  "$MP" start "$NAME" </dev/null
  echo "   downloading and rebuilding the node in the VM (a few minutes)"
  if [ -n "$TOKEN" ]; then
    printf '%s\n' "$TOKEN" | "$MP" exec "$NAME" -- sudo /usr/local/sbin/rose-node-install --token-stdin \
      || die "updating the node failed: $MP exec $NAME -- sudo tail -n 30 /var/log/rose-node-install.log"
  else
    vmx /usr/local/sbin/rose-node-install \
      || die "updating the node failed: $MP exec $NAME -- sudo tail -n 30 /var/log/rose-node-install.log"
  fi
  wait_online
  done_msg
  exit 0
fi

# ---------------------------------------------------------------- new VM
[ -n "$TOKEN" ] || die "missing --token (ask the hub owner for a join token)"
ok "token $(mask "$TOKEN")"
say "Creating the VM $NAME (Ubuntu 24.04, downloads about 600 MB the first time)"
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/tmpl.yaml" "$HUB/node/cloud-init.yaml" || die "could not download $HUB/node/cloud-init.yaml"
grep -q '@@NODE_TOKEN@@' "$work/tmpl.yaml" || die "the hub's cloud-init has no token placeholder; is it a Rose hub?"
# The token is NOT put in the cloud-init (Multipass keeps that on disk as the VM's seed ISO): it is
# piped into the VM once it is up. The hub URL is checked above (no sed-special characters but /).
sed -e "s|@@HUB_URL@@|$HUB|g" -e "s|@@NODE_TOKEN@@||g" -e "s|@@MAX_SESSIONS@@|$MAX|g" -e "s|@@INSECURE@@|$INSECURE|g" \
  "$work/tmpl.yaml" > "$work/user-data.yaml"
set +e
"$MP" launch 24.04 --name "$NAME" --cpus "$CPUS" --memory "${MEM}G" --disk "${DISK}G" \
  --cloud-init "$work/user-data.yaml" --timeout 1800 </dev/null
rc=$?
set -e
rm -rf "$work"
case "$rc" in
  0) ok "VM started" ;;
  75) warn "Multipass stopped waiting, but the VM keeps starting" ;;
  *) vm_exists || die "multipass launch failed (exit $rc). Check: $MP info --all"
     warn "multipass launch exited $rc; continuing" ;;
esac
# Hand the token to the VM (on stdin: not in any file or command line here), retrying while it boots.
i=0
until printf '%s\n' "$TOKEN" | "$MP" exec "$NAME" -- sudo /usr/local/sbin/rose-node-install --token-stdin; do
  i=$((i + 1)); [ $i -lt 60 ] || die "could not hand the token to the VM. Look inside: $MP shell $NAME, then: sudo tail /var/log/cloud-init-output.log"
  sleep 10
done
wait_online
done_msg
exit 0
}
