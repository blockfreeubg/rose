#!/usr/bin/env bash
# One-time host setup (Arch/CachyOS; adapt package commands for other distros).
# Safe to re-run. Ends by starting Rose.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Checking kernel support for Android binder =="
if zcat /proc/config.gz 2>/dev/null | grep -q 'CONFIG_ANDROID_BINDERFS=y'; then
  echo "binderfs built into kernel: OK"
elif sudo modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null; then
  echo "loaded binder_linux module: OK"
  echo 'binder_linux' | sudo tee /etc/modules-load.d/redroid.conf >/dev/null
  echo 'options binder_linux devices=binder,hwbinder,vndbinder' | sudo tee /etc/modprobe.d/redroid.conf >/dev/null
else
  echo "!! No binder support. Use a kernel with CONFIG_ANDROID_BINDERFS (e.g. linux-zen/cachyos) or install binder_linux-dkms." >&2
  exit 1
fi

echo "== Loading uhid (virtual gamepads, needed by console emulators) =="
# Rose turns browser controllers and the keyboard into a real Android gamepad through /dev/uhid.
# This kernel builds it as a module and doesn't autoload it from inside containers.
if lsmod | grep -q '^uhid\b' || sudo modprobe uhid; then
  echo 'uhid' | sudo tee /etc/modules-load.d/rose-uhid.conf >/dev/null
  echo "uhid: OK (loaded now and at every boot)"
else
  echo "!! Could not load uhid: emulators will only get touch input (controllers/keyboard won't reach them)." >&2
fi

if ! command -v docker >/dev/null; then
  echo "== Installing Docker =="
  sudo pacman -S --needed --noconfirm docker docker-compose docker-buildx acl
fi
sudo systemctl enable --now docker

echo "== Giving $USER access to Docker =="
# Group membership (permanent, but only applies to NEW logins)...
id -nG "$USER" | tr ' ' '\n' | grep -qx docker || sudo usermod -aG docker "$USER"
# ...so also grant access to the socket right now, which fixes
# "permission denied ... docker.sock" in already-open terminals without logging out.
sudo setfacl -m "u:$USER:rw" /var/run/docker.sock
docker info >/dev/null && echo "docker access: OK"

echo "== Pulling Android image =="
docker pull redroid/redroid:12.0.0_64only-latest

echo "== Starting Rose =="
# start.sh also creates apks/, files/ and roms/ as you (not root) before compose runs.
echo "(later: ./start.sh to restart/rebuild)"
exec ./start.sh
