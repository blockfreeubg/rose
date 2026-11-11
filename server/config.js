// All tunables come from env vars so docker-compose.yml is the single place to configure things.
import { autoMaxSessions } from './specs.js';

const env = (k, d) => process.env[k] ?? d;
const num = (k, d) => Number(env(k, d));
const flag = (k, d) => /^(1|true|on|yes)$/i.test(String(env(k, d)));
// Node mode: this Rose runs sessions on someone else's machine for a hub (the main Rose), and dials
// out to it over one websocket (nodes.js on the hub, node-agent.js here). Set by ROSE_HUB_URL.
const nodeMode = !!env('ROSE_HUB_URL', '');
// MAX_SESSIONS=auto sizes the machine from its RAM and CPU (specs.js); the default on nodes.
const maxSessions = (() => {
  const v = String(env('MAX_SESSIONS', nodeMode ? 'auto' : 4)).trim();
  return /^auto$/i.test(v) ? autoMaxSessions() : Number(v);
})();

export const config = {
  port: num('PORT', 8080),
  // A second port for cloudflared running on the host (scripts/rose-tunnel.service): compose publishes
  // it on 127.0.0.1 only, and visitors' CF-Connecting-IP is trusted only on it. 0 = off.
  tunnelPort: num('TUNNEL_PORT', 0),
  accessToken: env('ACCESS_TOKEN', ''),            // empty = no auth (LAN use only!)
  // Needed to add, edit or remove library entries (the #upload page). Sent as x-upload-password.
  uploadPassword: env('UPLOAD_PASSWORD', 'uploadingpass'),

  // Android image. The default is 64-bit only and lean; it translates ARM-only apps, but
  // emulators should be x86_64 builds (e.g. Eden's "chromeos" APK) to run at full speed.
  image: env('REDROID_IMAGE', 'redroid/redroid:12.0.0_64only-latest'),
  // The same Android with another ARM translator, for the games whose library entry asks for it
  // (translator: 'houdini' | 'ndk'): some ARM games only run under Intel's libhoudini, others only
  // under Google's ndk_translation. Unset = that game uses REDROID_IMAGE like everything else.
  translatorImages: { houdini: env('HOUDINI_IMAGE', ''), ndk: env('NDK_IMAGE', '') },
  // One label, network and name prefix per Rose instance on a host: a hub and a node on the same
  // machine never clean up (or reach) each other's session containers.
  instanceId: env('ROSE_INSTANCE', nodeMode ? 'node' : 'hub'),
  network: env('DOCKER_NETWORK', nodeMode ? 'rose-node' : 'rose'),
  containerPrefix: env('CONTAINER_PREFIX', nodeMode ? 'rose-n-' : 'rose-s-'),

  // Per-session resource limits: this is what keeps each session lightweight.
  memoryMb: num('SESSION_MEMORY_MB', 2048),
  // Swap allowance on top of the RAM limit (a fixed amount, also for grown sessions). On a host
  // with zram this lets the kernel compress a session's cold pages instead of keeping them in RAM.
  sessionSwapMb: num('SESSION_SWAP_MB', 1024),
  cpus: num('SESSION_CPUS', 2),
  width: num('SESSION_WIDTH', 720),
  height: num('SESSION_HEIGHT', 1280),
  dpi: num('SESSION_DPI', 280),
  fps: num('SESSION_FPS', 60),
  gpuMode: env('GPU_MODE', 'host'),                // host (uses /dev/dri) | guest (CPU SwiftShader)

  // Stream settings
  maxSize: num('STREAM_MAX_SIZE', 1024),
  bitrate: num('STREAM_BITRATE', 6_000_000),
  maxFps: num('STREAM_MAX_FPS', 60),
  // Game audio (Opus, ~100 kbps per listening viewer, ~2% of a core per session). AUDIO=0 turns it off.
  audio: !/^(0|false|off|no)$/i.test(env('AUDIO', '1')),

  // Capacity / lifecycle
  maxSessions,
  poolSize: num('POOL_SIZE', nodeMode ? 0 : 1),                  // pre-booted sessions for instant start
  idleTimeoutSec: num('IDLE_TIMEOUT_SEC', 120),    // destroy after no viewers for this long
  maxSessionMin: num('MAX_SESSION_MIN', 240),
  bootTimeoutSec: num('BOOT_TIMEOUT_SEC', 120),
  // End a session whose viewers have all had the page hidden (background tab) for this long.
  hiddenTimeoutSec: num('HIDDEN_TIMEOUT_SEC', 1200),
  // Don't boot a pool session unless the host has this much free memory beyond one session's limit.
  poolMinFreeMb: num('POOL_MIN_FREE_MB', 3072),

  apkDir: env('APK_DIR', new URL('../apks', import.meta.url).pathname),
  fileDir: env('FILE_DIR', new URL('../files', import.meta.url).pathname),
  // Your own game files for emulated systems: roms/<system>/ (e.g. roms/switch/game.nro).
  romDir: env('ROM_DIR', new URL('../roms', import.meta.url).pathname),

  // Games and apps can live on external sites (library entries with apkUrl/romUrl): they're
  // downloaded when played into this cache, capped at CACHE_MB (least recently used goes first).
  // CACHE_MB=0 keeps nothing: download, install, delete.
  cacheDir: env('CACHE_DIR', new URL('../cache', import.meta.url).pathname),
  cacheMb: num('CACHE_MB', 8192),
  // Largest file a download link (or a game inside a downloaded zip) may be: links with no
  // Content-Length, or zips that unpack to far more than they weigh, would otherwise fill the disk.
  maxDownloadMb: num('MAX_DOWNLOAD_MB', 16384),

  // Emulated consoles need far more than a phone game: a session is grown to these limits
  // when one of their games starts (Eden alone uses ~4.5 GB).
  switchMemoryMb: num('SWITCH_MEMORY_MB', 6144),
  switchCpus: num('SWITCH_CPUS', 4),
  hostReserveMb: num('HOST_RESERVE_MB', 1024),     // RAM to leave the host when growing or booting a session
  defaultApks: env('DEFAULT_APKS', '').split(',').map(s => s.trim()).filter(Boolean),
  scrcpyServerPath: env('SCRCPY_SERVER', new URL('../scrcpy-server', import.meta.url).pathname),
  scrcpyVersion: env('SCRCPY_VERSION', '3.1'),

  // ---- Rose nodes (other people's machines that run sessions for this hub) ----
  nodeMode,
  hubUrl: env('ROSE_HUB_URL', '').replace(/\/+$/, ''),
  nodeToken: env('ROSE_NODE_TOKEN', ''),
  hubInsecure: flag('ROSE_HUB_INSECURE', '0'),     // node: allow a plain http:// hub on a public address
  listenHost: env('LISTEN_HOST', nodeMode ? '127.0.0.1' : '0.0.0.0'),
  nodeAllowUploads: flag('NODE_ALLOW_UPLOADS', '0'), // node: let players install their own apps/files
  // Hub: where new sessions go (local-first | nodes-first | balanced); the Hosts page can override it.
  scheduler: env('SCHEDULER', 'local-first'),
  nodeGraceSec: num('NODE_GRACE_SEC', 45),         // a node that drops comes back this soon: its sessions resume
  nodeMax: num('NODE_MAX', 50),                    // nodes online at once
  nodeMaxSessions: num('NODE_MAX_SESSIONS', 16),   // sessions per node, whatever it claims
  nodeMaxMbps: num('NODE_MAX_MBPS', 60),           // stream data a node may relay through the hub
  nodeMaxRttMs: num('NODE_MAX_RTT_MS', 250),       // slower nodes get no new sessions
  nodeSwitchDumps: flag('NODE_SWITCH_DUMPS', '0'), // Switch dumps (.nsp/.xci) may be played on nodes
  publicUrl: env('PUBLIC_URL', '').replace(/\/+$/, ''),  // hub URL shown in the node install command
};
