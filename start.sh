
set -euo pipefail
cd "$(dirname "$0")"
if ! docker info >/dev/null 2>&1; then
  echo "Granting $USER access to the Docker socket (needs sudo once)…"
  sudo setfacl -m "u:$USER:rw" /var/run/docker.sock
fi

mkdir -p apks files roms

if [ -n "$(find roms -type d ! -user "$(id -u)" -print -quit 2>/dev/null)" ]; then
  echo "A folder in roms/ is owned by root (made by Docker or by Rose), so you can't add games/keys there. Giving roms/ back to $USER (sudo)…"
  sudo chown -R "$(id -u):$(id -g)" roms || echo "!! Couldn't fix it. Run: sudo chown -R $USER: $PWD/roms" >&2
fi
mkdir -p roms/switch/keys roms/switch/firmware 2>/dev/null || true
lsmod | grep -q '^uhid\b' || echo "Note: the uhid module isn't loaded, so controllers/keyboard won't reach emulators. Run ./scripts/setup-host.sh (or: sudo modprobe uhid). Until then gamepad buttons are ignored in Switch games; use touch."
if ! docker compose up -d --build; then
  if docker image inspect rose-rose >/dev/null 2>&1; then
    echo "Image rebuild failed; starting Rose with the existing image (your code changes still apply)."
    docker compose up -d --no-build
  else
    exit 1
  fi
fi
echo
echo "Rose is running → http://localhost:8080"
