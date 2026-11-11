# 🌹 Rose — lightweight cloud Android gaming

# ADD AN "apks" FOLDER FOR YOUR APKS
# ADD AN "files" FOLDER SO DOWNLOADS WORK
# ADD AN "roms" FOLDER IF YOU WANT SWITCH ROMS TO WORK

Each player session is a throwaway **Redroid** container (Android running directly on the
host kernel, no VM), streamed to the browser with **scrcpy** (H.264), decoded with
**WebCodecs**, and controlled with touch, mouse, keyboard or gamepad.

```
browser ──WebSocket──▶ rose (Node) ──adb/scrcpy──▶ redroid container (1 per session)
 library · player        sessions · library          Android 12, ephemeral
```

## Why it's lightweight
- **No VM.** Redroid shares the host kernel, so an idle session uses ~300–600 MB RAM and boots in ~5–15 s.
- **Hard caps per session** (`SESSION_MEMORY_MB`, `SESSION_CPUS`) via cgroups.
- **Ephemeral.** Containers use `AutoRemove`; ending a session deletes everything. Nothing leaks between players.
- **Debloated on boot.** Animations are off and background processes are limited.
- **Warm pool** (`POOL_SIZE`). Pre-booted sessions make "Play" near-instant.
- **Idle reaper.** A session with no viewers for `IDLE_TIMEOUT_SEC` is destroyed.
- **Adaptive stream.** Slow clients skip to the next keyframe instead of building up lag.

## Setup (this machine: CachyOS, kernel has binderfs built in)
```bash
./scripts/setup-host.sh   # once: installs Docker, checks binder, pulls the Android image
./start.sh                # start/rebuild Rose → http://localhost:8080
```
WebCodecs only works in a **secure context**: `localhost` works, but other devices need HTTPS.
The easiest options are the Cloudflare tunnel below, `tailscale serve 8080`, or Caddy (`caddy reverse-proxy --from your.domain --to :8080`).
Before exposing Rose beyond your machine, **turn on accounts** (`ACCOUNTSETUP.md`) or set `ACCESS_TOKEN`, and set a strong
`ROSE_UPLOAD_PASSWORD` in `.env` (the default `uploadingpass` is public knowledge).

### Public link with Cloudflare (cloudflared on this PC)
A quick tunnel gives Rose a public `https://<random>.trycloudflare.com` address with no Cloudflare account. It runs as a
boot service and talks to Rose on `127.0.0.1:8081` (`TUNNEL_PORT`): that port is published on this PC only, and it's the only
place Rose trusts the visitor address Cloudflare reports (used for per-visitor password-guessing limits).
```bash
sudo pacman -S --needed cloudflared
sudo install -m 644 scripts/rose-tunnel.service /etc/systemd/system/rose-tunnel.service
sudo systemctl daemon-reload && sudo systemctl enable --now rose-tunnel
scripts/tunnel-url.sh        # prints the current link (a new one every time the tunnel restarts)
```
Stop sharing with `sudo systemctl disable --now rose-tunnel`. (No install: `docker compose --profile tunnel up -d` runs
cloudflared as a container instead; its link is in `docker logs rose-tunnel`.)

The code runs straight from `server/` and `public/` (mounted into the container), so after a code change
`docker restart rose` is enough; no image rebuild is needed. `start.sh` falls back to the existing image if a rebuild fails.
`start.sh` also creates `apks/`, `files/` and `roms/switch/{keys,firmware}` as your user (Docker would make them root-owned),
and if `roms/` is already root-owned it fixes that with one `sudo chown`.

## Library
The home page is the game library. Click a cover to boot a session, install the game and launch it.
- **Add game** lets you upload a game file, **paste a download link**, or reuse a file already on the server, and set a title, category and cover.
- **Download links keep the server small.** A link entry stores nothing but its cover: the file is downloaded when someone
  plays it and kept in a cache capped at `CACHE_MB` (least recently played goes first; `0` = keep nothing). Links can point
  at an `.apk`, a bundle (`.apkm`/`.apks`/`.xapk`), a Switch game, or a `.zip` containing one. Rose works out the type from
  the file itself. The built-in apps use APKPure's public download links (`https://d.apkpure.net/b/XAPK/<package>?version=latest`), so they're always the latest version.
- Any `.apk` dropped into `apks/` appears automatically with a title taken from its filename.
- **Emulated games.** Choose the emulator's APK as the game and pick a *companion file* from `files/`.
  That file is pushed to `/sdcard/Download` before launch so the emulator can open it.
- ⋯ on a card lets you edit or remove it. Categories become filter chips, and the search box filters by title.
- **Per-game settings** (in `apks/library.json` with Rose stopped, or `PATCH /api/library/:id` with the upload password):
  `memoryMb` / `cpus` give that game a bigger session (it grows when the game starts, if the host has the memory free),
  and `translator: "houdini"` (or `"ndk"`) runs it on the other ARM translator (see `HOUDINI_IMAGE` below).
- **Keyboard to touch controls** (landscape games): `Ctrl` + `G` → *Edit controls*. Drag a control to move it; to resize,
  scroll over it, drag its white dot, use the *Size* sliders in its settings, or press `+` / `−` (with nothing selected,
  every control). *All sizes − / +* scales the whole layout. A joystick's size is how far the keys slide your finger.
- If you close the tab, the home page offers to **resume** the running session until the idle timeout ends it.
- The library is stored in `apks/library.json`, and covers in `apks/covers/`.

## Nintendo Switch (Eden)
Switch games run in [Eden](https://eden-emu.dev), using its official **x86_64** Android build (the `chromeos` APK). It runs
natively in Redroid with Vulkan on the host GPU, with no ARM translation.
- **One click to play.** Rose grows the session to `SWITCH_MEMORY_MB`/`SWITCH_CPUS` (Eden alone uses ~4.5 GB), installs
  Eden while the game downloads, copies the game into Eden's storage and boots straight into it, with no setup wizard and no
  file picker. If the host is short on memory, Rose says so instead of starting a session that would crash.
- **Free homebrew comes preloaded** as download links to each project's official release (see each game's details for its
  author and license). Rose never ships or downloads commercial games, keys or firmware.
- **Your own games:** drop `.nro`, `.nsp` or `.xci` files into `roms/switch/` (or upload them with **Add game**). They show up
  in the library with their real title and icon (for `.nro`). Commercial dumps also need **your own** keys and firmware:
  put `prod.keys`/`title.keys` in `roms/switch/keys/` and firmware `.nca` files in `roms/switch/firmware/`. Rose copies
  them into each session, because sessions are wiped when they end. Use only games, keys and firmware you dumped from your own console.
- **Controls:** plug in a controller, use Eden's on-screen buttons with the mouse or touch, or use the keyboard, which acts
  as controller 1 for console games (toggle it in the in-game menu, which also shows the keys):
  `WASD` left stick · `IJKL` right stick · arrows D-pad · `Z` A · `X` B · `C` X · `V` Y · `Q`/`E` ZL/L · `U`/`O` R/ZR · `Enter` + · `-` −.
- **Controllers and the keyboard need the `uhid` kernel module** on the host (`scripts/setup-host.sh` loads it now and at
  every boot; by hand: `sudo modprobe uhid`). Rose then creates a real virtual gamepad inside Android, which Eden requires.
  Without it, Eden only gets touch input: Rose sends no gamepad buttons to it at all, because Android would turn the
  unhandled ones into Back/Home and quit the game. The session info (`uhid: false`) reports this.
- Open the **Eden** tile itself to change emulator settings. Settings last until the session ends.

## Important limitations
- **ARM apps on an x86 host.** The default image is x86_64 and translates ARM-only apps with Google's ndk_translation
  (this one reports `x86_64,arm64-v8a`). That's fine for most games, but emulators should be x86_64 builds: an ARM
  emulator under translation is far too slow. Some games (Soul Knight, Super Sus, Free Fire, Subway Surfers City,
  Master Duel) crash under ndk_translation but run under Intel's libhoudini (`HOUDINI_IMAGE`), so a game's library
  entry can pick its translator (`translator: "houdini"`). libhoudini isn't the default: it hasn't been checked against
  the whole library, and some games refuse it (Supercell's Clash Royale, Brawl Stars and Hay Day crash on purpose under
  it, and abort under ndk_translation too). A game on the other translator starts in a freshly booted session, a few
  seconds slower than a warm one.
- **Roblox** may detect emulators or cloud hosting, and running it this way may conflict with its Terms of Use.
- **Switch emulation is heavy.** Light homebrew and 2D games run well on an integrated GPU; big 3D
  commercial games may be slow or not boot. Each Switch session uses ~4.5–6 GB, so keep `MAX_SESSIONS` low.
- **No audio yet.** Redroid has no real audio device. scrcpy audio capture could be added later.
- **Gamepads** become a real virtual controller inside Android when the host has the `uhid` module;
  otherwise they're sent as Android gamepad key events, which many games accept but emulators ignore.

## Config (env vars in docker-compose.yml)
| Var | Default | |
|---|---|---|
| `MAX_SESSIONS` | 4 | concurrent sessions, including warm ones |
| `POOL_SIZE` | 1 | pre-booted sessions |
| `SESSION_MEMORY_MB` / `SESSION_CPUS` | 2048 / 2 | per-session limits |
| `SESSION_WIDTH/HEIGHT/DPI` | 720/1280/280 | virtual screen |
| `STREAM_BITRATE` / `STREAM_MAX_FPS` | 6 Mbps / 60 | |
| `GPU_MODE` | host | `host` = /dev/dri passthrough, `guest` = CPU rendering |
| `IDLE_TIMEOUT_SEC` | 120 | |
| `DEFAULT_APKS` | — | APKs preinstalled in warm sessions |
| `ACCESS_TOKEN` | — | required for API/WebSocket if set |
| `CACHE_MB` | 1024 | cache for games from download links (LRU); `0` = delete after install |
| `SWITCH_MEMORY_MB` / `SWITCH_CPUS` | 6144 / 4 | a session grows to this when a Switch game starts |
| `HOST_RESERVE_MB` | 1024 | RAM to leave the host when growing a session (memory already promised to other grown sessions counts as used) |
| `ROM_DIR` / `CACHE_DIR` | `roms/` / `cache/` | your console games / download cache (a Docker volume in compose) |
| `REDROID_IMAGE` | `redroid/redroid:12.0.0_64only-latest` | the Android image every session boots (ndk_translation for ARM apps) |
| `HOUDINI_IMAGE` / `NDK_IMAGE` | — | the same Android with libhoudini / ndk_translation, for games whose entry sets `translator` |
