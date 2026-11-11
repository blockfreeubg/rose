// Session lifecycle: each session = one throwaway Redroid container + one scrcpy stream.
// A small warm pool of pre-booted containers makes "Play" near-instant.
import Docker from 'dockerode';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { Adb, isHome } from './adb.js';
import { Scrcpy } from './scrcpy.js';
import { NEUTRAL, BTN, padKeys } from './gamepad.js';
import { systemFor } from './emulators.js';

const docker = new Docker();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const MB = 1024 * 1024;

// Sessions grown past SESSION_MEMORY_MB. Raising a cgroup limit uses no RAM, so free memory alone
// can't tell what's already promised: a grown session whose emulator hasn't loaded yet will still
// take its grant. ensureResources() counts that unused headroom, one check at a time (`serial`), so
// two Switch starts can't both pass against the same free memory.
const grown = new Set();
let lock = Promise.resolve();
const serial = fn => { const r = lock.then(fn); lock = r.catch(() => {}); return r; };

/** MB the host can still hand out: MemAvailable, minus grants grown sessions haven't used yet. */
async function availableMb(except) {
  const others = [...grown].filter(s => s !== except && s.state !== 'dead');
  const promisedMb = (await Promise.all(others.map(headroomMb))).reduce((a, b) => a + b, 0);
  return os.freemem() / MB - promisedMb;   // os.freemem() is MemAvailable on Linux
}

/** Run a command in a container (docker exec); resolves with its exit code. */
async function dockerExec(container, cmd, timeoutMs = 30_000) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  await new Promise((res, rej) => {
    const t = setTimeout(() => { stream.destroy(); rej(new Error('exec timed out')); }, timeoutMs);
    stream.on('data', () => {});
    stream.on('end', () => { clearTimeout(t); res(); });
    stream.on('error', e => { clearTimeout(t); rej(e); });
  });
  return (await exec.inspect()).ExitCode;
}

const WATCH_MS = 2000;               // game watchdog: how often to look whether the game is still in front
const REEXIT_MS = 60_000;            // left again this soon after an automatic restart: stop restarting
const QUEUE_STALE_MS = 90_000;     // a waiting page that has not polled this long left (background tabs poll slowly)
const QUEUE_MAX = 200;
const HIDDEN_THROTTLE_MS = 15_000;   // all viewers hidden this long: slow the session down
const HIDDEN_NANO_CPUS = 0.5e9;
const AUDIO_MAX_BUFFERED = 256 * 1024;   // skip audio frames for a viewer whose socket holds more than this

/** MB a grown session may still take: its limit minus what it uses now (reclaimable cache excluded). */
async function headroomMb(s) {
  try {
    const timeout = new Promise((_, no) => setTimeout(no, 5000, new Error('stats timeout')).unref());
    const m = (await Promise.race([s.container.stats({ stream: false, 'one-shot': true }), timeout])).memory_stats;
    const used = m.usage - (m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0);
    if (!Number.isFinite(used)) throw new Error('no memory stats'); // stopped/restarting: memory_stats is {}
    return Math.max(0, s.memoryMb - used / MB);
  } catch {
    return s.memoryMb - config.memoryMb;    // stats unavailable: assume the whole grant is unused
  }
}

class Session extends EventEmitter {
  /** `image`: the Android image to boot (a game's own translator, index.js imageFor), else REDROID_IMAGE. */
  constructor(id, image = config.image) {
    super();
    this.id = id;
    this.image = image;
    this.name = config.containerPrefix + id;
    this.adb = new Adb(`${this.name}:5555`);
    this.state = 'booting';          // booting -> ready (pooled) -> active -> dead
    this.viewers = new Set();
    this.createdAt = Date.now();
    this.lastSeen = Date.now();
    this.apps = [];                  // packages installed this session
    this.apkPkgs = {};               // apk filename -> packages it installed
    this.game = null;
    this.memoryMb = config.memoryMb; // current container limits (grown for emulators)
    this.cpus = config.cpus;
    this.uhid = false;               // can the scrcpy server create virtual gamepads?
    this.pads = new Map();           // pad slot -> { open, keys }
    this.prepared = new Set();       // emulated systems already set up in this session
    this.system = undefined;         // emulated system being played (index.js), null = Android app
    this.hiddenSince = 0;            // when every viewer last had the page hidden (0 = someone can see it)
    this.throttled = false;          // CPU cut to HIDDEN_NANO_CPUS while nobody is watching
    this.gamePkg = null;             // package of the game in front (index.js startGame); an emulator for console games
    this.watch = null;               // game watchdog: { pkg, run, restartedAt, exited, blank } (setGame)
  }

  /** `pool`: a warm pool boot, which runs at low CPU priority until a player claims it. */
  async boot({ pool = false } = {}) {
    const devices = [];
    if (config.gpuMode === 'host') devices.push({ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' });
    const container = await docker.createContainer({
      name: this.name,
      Image: this.image,
      Labels: { 'rose.session': this.id, 'rose.instance': config.instanceId },
      Cmd: [
        `androidboot.redroid_width=${config.width}`,
        `androidboot.redroid_height=${config.height}`,
        `androidboot.redroid_dpi=${config.dpi}`,
        `androidboot.redroid_fps=${config.fps}`,
        `androidboot.redroid_gpu_mode=${config.gpuMode}`,
        'androidboot.use_memfd=true',
        // lmkd reads the HOST's memory pressure (PSI) and watermarks, not this container's limit, so a
        // host that is briefly swapping makes it kill the foreground app (an emulator) as "not
        // responding". The container's cgroup limit already bounds the session; only let lmkd act on
        // its own memory accounting. (lmkd must keep running: ActivityManager can't start apps without it.)
        'ro.lmk.psi_complete_stall_ms=999',   // full-stall trigger (default 700 ms of each 1 s window)
        'ro.lmk.thrashing_limit=100',         // max: never kill for file-cache thrashing
        'ro.lmk.thrashing_limit_decay=0',
        'ro.lmk.swap_free_low_percentage=0',  // host swap use isn't ours to judge
        // Smaller Java heaps: less free space kept above live data, and less held after a GC.
        'dalvik.vm.heaptargetutilization=0.75',
        'dalvik.vm.heapmaxfree=8m',
      ],
      HostConfig: {
        Privileged: true,            // required by Redroid (binderfs, mounts)
        AutoRemove: true,            // container + its writable layer vanish on stop
        NetworkMode: config.network,
        Memory: config.memoryMb * MB,
        MemorySwap: (config.memoryMb + config.sessionSwapMb) * MB,   // RAM + swap (host zram)
        NanoCpus: Math.round(config.cpus * 1e9),
        // Pool boots yield to running games (weight ~10 vs the default ~100); create() restores it.
        ...(pool ? { CpuShares: 256 } : {}),
        PidsLimit: 4096,
        Devices: devices,
      },
    });
    this.container = container;
    await container.start();
    await this.adb.waitForBoot(config.bootTimeoutSec);
    await this.adb.optimize();
    for (const apk of config.defaultApks) await this.installApk(path.join(config.apkDir, path.basename(apk)));
    this.state = 'ready';
    log(`session ${this.id} booted in ${((Date.now() - this.createdAt) / 1000).toFixed(1)}s`);
    // In the background: never delays a claim. SessionManager waits on it before reclaim().
    this.slimmed = this.adb.disableUnusedApps()
      .catch(e => log(`session ${this.id}: could not disable unused apps: ${e.message.split('\n')[0]}`));
  }

  /**
   * Push an idle pooled session's cold memory (boot leftovers) out to swap (zram) once, through
   * its cgroup's memory.reclaim. Best effort: errors are only logged.
   */
  async reclaim() {
    const f = '/sys/fs/cgroup/memory.reclaim';
    try {
      // swappiness= needs a recent kernel; older ones reject it, so retry with the plain amount.
      const code = await dockerExec(this.container, ['/system/bin/sh', '-c',
        `echo "400M swappiness=200" > ${f} 2>/dev/null || echo 400M > ${f}`]);
      // A non-zero code often just means it found less than 400M to reclaim (EAGAIN).
      log(`session ${this.id}: reclaimed cold memory${code ? ` (exit ${code}: partial or unsupported)` : ''}`);
    } catch (e) {
      log(`session ${this.id}: memory reclaim skipped: ${e.message}`);
    }
  }

  async activate() {
    this.state = 'active';
    this.activatedAt = Date.now();
    this.lastSeen = Date.now();
    this.scrcpy = new Scrcpy(this.adb, config.scrcpyServerPath, config.scrcpyVersion, {
      maxSize: config.maxSize, bitrate: config.bitrate, maxFps: config.maxFps, audio: config.audio,
    });
    this.scrcpy.on('packet', (kind, data) => {
      const msg = Buffer.allocUnsafe(1 + data.length);
      msg[0] = kind;
      data.copy(msg, 1);
      for (const ws of this.viewers) {
        if (ws.hidden) continue;     // page in the background: no video at all (setHidden() catches it up)
        // Drop delta frames for viewers whose socket is backed up; they'll catch up on the next keyframe.
        if (kind === 2 && ws.bufferedAmount > 2 * 1024 * 1024) { ws.needsKey = true; continue; }
        if (kind === 2 && ws.needsKey) continue;
        if (kind === 1) ws.needsKey = false;
        ws.send(msg);
      }
    });
    // Audio (kind 3 = OpusHead config, 4 = Opus frame) only goes to viewers that asked for it with
    // {t:'audio',on:true}: older pages would feed kinds 3/4 to their video decoder. Never to hidden
    // viewers, and skipped while a viewer's socket is backed up (stale audio is useless).
    this.scrcpy.on('audio', (kind, data) => {
      let msg = null;
      for (const ws of this.viewers) {
        // The config (rare, tiny) always goes: without it the viewer could decode nothing until it rejoins.
        if (!ws.audio || ws.hidden || (kind === 4 && ws.bufferedAmount > AUDIO_MAX_BUFFERED)) continue;
        if (!msg) {
          msg = Buffer.allocUnsafe(1 + data.length);
          msg[0] = kind;
          data.copy(msg, 1);
        }
        ws.send(msg);
      }
    });
    this.scrcpy.on('audiostate', on => { if (!on) this.tell({ t: 'audio', available: false }); });
    // The server was restarted without audio (it crashed on audio): everyone needs a new keyframe.
    this.scrcpy.on('restarted', () => {
      log(`session ${this.id}: stream restarted without audio`);
      for (const ws of this.viewers) if (!ws.hidden) ws.needsKey = true;
    });
    this.scrcpy.on('end', err => { log(`session ${this.id} stream ended: ${err?.message}`); this.emit('dead'); });
    await this.scrcpy.start();
    this.uhid = await this.adb.uhidReady();
  }

  /**
   * Grow the container's limits for a demanding game (emulators). Limits only ever go up for the
   * rest of the session. Refuses if the host would be left with less than HOST_RESERVE_MB free.
   */
  ensureResources({ memoryMb = 0, cpus = 0 } = {}) {
    return serial(async () => {
      if (this.state === 'dead') return;
      const mem = Math.max(this.memoryMb, memoryMb);
      const cpu = Math.max(this.cpus, cpus);
      if (mem === this.memoryMb && cpu === this.cpus) {
        // Already big enough (grown earlier, then releaseGrant()): its grant counts again.
        if (memoryMb > config.memoryMb) grown.add(this);
        return;
      }
      const extraMb = mem - this.memoryMb;
      if (extraMb > 0) {
        // MemAvailable on Linux, minus what other grown sessions were promised but haven't used yet.
        const freeMb = await availableMb(this);
        if (freeMb - extraMb < config.hostReserveMb) {
          throw Object.assign(new Error(
            `The server is short on memory for this game right now: it needs about ${(mem / 1024).toFixed(1)} GB `
            + `and ${(Math.max(0, freeMb) / 1024).toFixed(1)} GB is free. End another session and try again.`), { status: 503 });
        }
      }
      await this.container.update({
        Memory: mem * MB, MemorySwap: (mem + config.sessionSwapMb) * MB,   // same fixed swap allowance
        NanoCpus: this.throttled ? HIDDEN_NANO_CPUS : Math.round(Math.min(cpu, os.cpus().length) * 1e9),
      });
      this.memoryMb = mem;
      this.cpus = cpu;
      if (mem > config.memoryMb) grown.add(this);
      log(`session ${this.id} grown to ${mem} MB, ${cpu} CPUs`);
    });
  }

  /**
   * The session stopped playing what it grew for (index.js: an Android game is now playing). Its
   * limits stay as they are, but its unused grant no longer counts against other sessions.
   */
  releaseGrant() {
    grown.delete(this);
  }

  /** A viewer's page was hidden or shown again ({t:'hidden'|'visible'} on /ws). Not activity. */
  setHidden(ws, hidden) {
    if (!this.viewers.has(ws)) return;
    if (!!ws.hidden === hidden) {
      // 'visible' from a page that never sent 'hidden' (it hid before its first frame): it still reset
      // its audio decoder, so it needs the OpusHead again or it would stay silent.
      if (!hidden && ws.audio) this.sendAudioConfig(ws);
      return;
    }
    ws.hidden = hidden;
    if (!hidden) this.catchUp(ws);
    this.updateHidden();
  }

  /** Give a viewer that (re)starts watching the codec config and a fresh keyframe (and the audio config). */
  catchUp(ws) {
    if (this.scrcpy?.config) ws.send(Buffer.concat([Buffer.from([0]), this.scrcpy.config]));
    ws.needsKey = true;
    this.scrcpy?.resetVideo();
    if (ws.audio) this.sendAudioConfig(ws);
  }

  /** A viewer turned its audio on or off ({t:'audio', on}). On: it gets the cached OpusHead first. */
  setAudio(ws, on) {
    if (!this.viewers.has(ws) || !!ws.audio === on) return;
    ws.audio = on;
    if (on && !ws.hidden) this.sendAudioConfig(ws);
    if (on && this.scrcpy && !this.scrcpy.audio) {
      ws.send(JSON.stringify({ t: 'audio', available: false }));   // this stream has no audio at all
    }
  }

  sendAudioConfig(ws) {
    const c = this.scrcpy?.audioConfig;
    if (c && ws.readyState === 1) ws.send(Buffer.concat([Buffer.from([3]), c]));
  }

  /** Throttle the CPU once every viewer has been hidden for a while; restore it when one looks. */
  updateHidden() {
    const allHidden = this.viewers.size > 0 && [...this.viewers].every(ws => ws.hidden);
    if (allHidden) {
      if (this.hiddenSince) return;
      this.hiddenSince = Date.now();
      this.hiddenTimer = setTimeout(() => this.throttle(true), HIDDEN_THROTTLE_MS);
      this.hiddenTimer.unref();
    } else {
      this.hiddenSince = 0;
      clearTimeout(this.hiddenTimer);
      if (this.throttled) this.throttle(false);
    }
  }

  /** Soft-throttle (never docker pause: the game keeps running, just slower) or restore the CPU. */
  throttle(on) {
    if (this.state !== 'active' || this.throttled === on) return;
    this.throttled = on;
    serial(async () => {
      if (this.state === 'dead') return;
      // Restoring uses the current limit, which may have grown since the throttle.
      await this.container.update({ NanoCpus: on ? HIDDEN_NANO_CPUS : Math.round(Math.min(this.cpus, os.cpus().length) * 1e9) });
      log(`session ${this.id} ${on ? 'throttled: all viewers hidden' : 'unthrottled'}`);
    }).catch(e => log(`session ${this.id}: could not ${on ? 'throttle' : 'unthrottle'}: ${e.message}`));
  }

  // ---- game watchdog: the player only ever sees the game ----

  /**
   * The game `pkg` was just launched (and pinned) by `run`, which relaunches it. From now on, if
   * the game leaves the front (a home screen resumed, nothing resumed, or its process died), it is
   * restarted once ({t:'game', state:'restarted'}); if it leaves again within REEXIT_MS, or the
   * restart fails, viewers get {t:'game', state:'exited'} and it waits for a {t:'relaunch'}.
   */
  setGame(pkg, run) {
    this.watch = { pkg, run, restartedAt: 0, exited: false, blank: 0 };
    this.tell({ t: 'game', state: 'running' });   // clears a "closed" screen (e.g. an uploaded APK became the game)
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => this.checkGame(), WATCH_MS);
      this.watchTimer.unref();
    }
  }

  /** A launch is starting (index.js): don't count its stop/start as the game leaving. */
  clearGame() {
    this.watch = null;
  }

  /** Send a JSON message to every viewer. */
  tell(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.viewers) if (ws.readyState === 1) ws.send(text);
  }

  async checkGame() {
    const w = this.watch;
    // Never overlap checks; only look while someone is watching and the session runs at full speed.
    if (!w || w.exited || this.checking || this.state !== 'active' || !this.viewers.size || this.throttled || this.hiddenSince) return;
    this.checking = true;
    try {
      const st = await this.adb.gameState(w.pkg);
      if (this.watch !== w) return;
      const top = st.top;
      // The game's package in front means it runs, even in a process pidof doesn't find (pkg:name).
      const alive = st.alive || top?.pkg === w.pkg;
      // The game's own activities, its permission dialogs, the IME, a picker, an installer or a
      // login browser it opened all leave the game alive and are not a home screen: not an exit.
      // Nothing resumed at all (no home exists, so Back past the game's root ends up there) is,
      // once it lasts two checks in a row (it is also briefly true between two activities).
      w.blank = alive && !top ? w.blank + 1 : 0;
      if (alive && !isHome(top) && w.blank < 2) return;
      log(`session ${this.id}: ${w.pkg} left the front (${alive ? `${top ? top.pkg : 'nothing'} resumed` : 'process died'})`);
      if (w.restartedAt && Date.now() - w.restartedAt < REEXIT_MS) return this.gameExited(w);
      w.restartedAt = Date.now();
      await this.runGame(w, 'restarted');
    } catch (e) {
      log(`session ${this.id}: game check failed: ${e.message.split('\n')[0]}`);
    } finally {
      this.checking = false;
    }
  }

  async runGame(w, state) {
    try {
      await w.run();
      w.blank = 0;
      if (this.watch === w) this.tell({ t: 'game', state });
    } catch (e) {
      log(`session ${this.id}: could not relaunch ${w.pkg}: ${e.message.split('\n')[0]}`);
      if (this.watch === w) this.gameExited(w);
    }
  }

  gameExited(w) {
    w.exited = true;
    this.tell({ t: 'game', state: 'exited' });
  }

  /** The player asked to restart the game after it closed ({t:'relaunch'}): relaunch and re-arm. */
  async relaunchGame() {
    for (let t = 0; this.checking && t < 100; t++) await new Promise(r => setTimeout(r, 200));   // a check or restart is running
    const w = this.watch;
    if (!w) return this.tell({ t: 'game', state: 'exited' });   // nothing to start: keep the "closed" screen
    if (!w.exited || this.state !== 'active') return;   // only after it closed: never restart a running game
    if (this.checking) return this.tell({ t: 'game', state: 'exited' });   // still busy: the player can retry
    this.checking = true;
    try {
      w.exited = false;
      w.restartedAt = 0;
      await this.runGame(w, 'running');
    } finally {
      this.checking = false;
    }
  }

  /** Apply a browser controller's state (see gamepad.js) to pad `slot` (0-3). */
  pad(slot, state) {
    const sc = this.scrcpy;
    if (!sc) return;
    let p = this.pads.get(slot);
    if (!p) this.pads.set(slot, (p = { open: false, keys: new Set() }));
    // A pad's Home/Guide button would mean Home to Android. Emulators read it themselves (the
    // console's own Home button), so it only reaches them.
    if (!this.system) state = { ...state, b: state.b & ~BTN.MODE };
    if (this.uhid) {
      if (!p.open) {
        sc.padOpen(slot + 1, `Rose Gamepad ${slot + 1}`);
        p.open = true;
      }
      sc.padInput(slot + 1, state);
    } else {
      // No uhid: fall back to Android gamepad key events. Gamepad-only emulators (Eden) ignore
      // those, and Android then applies the Virtual.kcm fallbacks (BUTTON_B/Y -> BACK, MODE -> HOME,
      // A/X/START/thumbs -> DPAD_CENTER, SELECT -> MENU), which pause or quit the game. So inject
      // nothing for them (an empty set still releases keys held from before).
      const keys = this.gamepadOnly() ? new Set() : padKeys(state);
      for (const k of keys) if (!p.keys.has(k)) sc.key(0, k);
      for (const k of p.keys) if (!keys.has(k)) sc.key(1, k);
      p.keys = keys;
    }
  }

  /** True while an emulator that only reads real controllers is being played. */
  gamepadOnly() {
    // Until index.js reports what's playing, any emulator set up in this session counts.
    const ids = this.system === undefined ? [...this.prepared] : [this.system];
    return ids.some(id => systemFor(id)?.controls === 'gamepad');
  }

  /** Let go of everything on a pad (a viewer left mid-press). */
  releasePad(slot) {
    if (this.pads.has(slot)) this.pad(slot, NEUTRAL);
  }

  // One install at a time per session: adb.install() reports what appeared between its own
  // before/after package lists, so overlapping installs would claim each other's apps.
  installApk(file) {
    const run = (this.installing || Promise.resolve()).then(() => this.installOne(file));
    this.installing = run.catch(() => {});
    return run;
  }

  async installOne(file) {
    let pkgs = await this.adb.install(file);
    const key = path.basename(file);
    if (!pkgs.length && this.apkPkgs[key]) pkgs = this.apkPkgs[key]; // reinstall of a known APK
    if (pkgs.length) this.apkPkgs[key] = pkgs;
    for (const p of pkgs) if (!this.apps.includes(p)) this.apps.push(p);
    return pkgs;
  }

  addViewer(ws) {
    this.viewers.add(ws);
    this.lastSeen = Date.now();
    this.catchUp(ws);
    this.updateHidden();             // a new viewer counts as visible until it says otherwise
    if (this.watch?.exited) ws.send(JSON.stringify({ t: 'game', state: 'exited' }));
    this.emit('change');
  }

  removeViewer(ws) {
    this.viewers.delete(ws);
    this.lastSeen = Date.now();
    this.updateHidden();
    this.emit('change');
  }

  info() {
    return {
      id: this.id, state: this.state, viewers: this.viewers.size, apps: this.apps, game: this.game,
      width: this.scrcpy?.width, height: this.scrcpy?.height, memoryMb: this.memoryMb, cpus: this.cpus,
      uhid: this.uhid,               // false = no virtual gamepad: controllers/keyboard can't reach emulators
      audio: !!this.scrcpy?.audio,   // the stream carries game audio (kinds 3/4 on /ws, after {t:'audio',on:true})
      uptimeSec: Math.round((Date.now() - this.createdAt) / 1000),
    };
  }

  async destroy() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    grown.delete(this);
    clearTimeout(this.hiddenTimer);
    clearInterval(this.watchTimer);
    this.watch = null;
    for (const ws of this.viewers) ws.close(1000, 'session ended');
    await this.scrcpy?.stop().catch(() => {});
    await this.adb.disconnect();
    await this.container?.stop({ t: 0 }).catch(() => {});
    await this.container?.remove({ force: true }).catch(() => {});
    log(`session ${this.id} destroyed`);
  }
}

const queueError = () => Object.assign(new Error('Every rig is busy right now. You are in line.'), { status: 503, queue: true });

/**
 * Local sessions, plus (on a hub) sessions on Rose nodes through `remote` (nodes.js NodeRegistry,
 * set by index.js): placement, the waiting line and stats count both. Emits 'change' (session) when a
 * local session starts, ends or its viewers change.
 */
export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();   // active sessions
    this.pool = [];              // ready, unclaimed sessions
    this.booting = 0;
    this.queue = [];             // waiting line when every slot is taken: [{ ticket, seen }]
    this.remote = null;          // NodeRegistry on a hub with nodes; null otherwise
  }

  // ---- Waiting line -------------------------------------------------------------------------
  // When all slots are busy, POST /api/sessions answers { queue: true } and the page joins the line,
  // polling its ticket every few seconds. A ticket that stops polling (tab closed) drops out. Only
  // the head of the line may take a slot that frees up; everyone else keeps waiting.
  // Rose+ members (plus.js; index.js decides from the signed-in account) wait ahead of everyone
  // else: the line is always their tickets, in the order they got priority, then the rest in the
  // order they joined. Without accounts nobody has priority, so it is plain first come, first served.
  localHasSlot() { return this.pool.length > 0 || this.total() < config.maxSessions; }
  /** A slot here or on a node that can run `game` (a library entry; null = any game). */
  hasSlot(game) { return this.localHasSlot() || !!this.remote?.hasSlot(game); }
  pruneQueue() {
    const now = Date.now();
    this.queue = this.queue.filter(q => now - q.seen < QUEUE_STALE_MS);
  }
  /** `priority`: a Rose+ member's ticket; `owner`: the account it belongs to (null without accounts). */
  queueJoin({ priority = false, owner = null } = {}) {
    this.pruneQueue();
    if (this.queue.length >= QUEUE_MAX) throw Object.assign(new Error('The waiting line is full. Try again in a few minutes.'), { status: 503 });
    const q = { ticket: crypto.randomBytes(12).toString('hex'), seen: Date.now(), at: Date.now(), priority: !!priority, owner };
    this.queuePlace(q);
    log(`queue: ticket joined${q.priority ? ' with Rose+ priority' : ''} (${this.queue.length} waiting)`);
    return this.queueStatus(q.ticket);
  }
  /** Puts a ticket where it belongs: last of the priority tickets, or among the rest by when it joined. */
  queuePlace(q) {
    const i = q.priority ? this.queue.findIndex(x => !x.priority) : this.queue.findIndex(x => !x.priority && x.at > q.at);
    if (i < 0) this.queue.push(q); else this.queue.splice(i, 0, q);
  }
  /**
   * Rose+ was turned on or off for an account: its tickets already in line move. Turned on, a ticket
   * goes behind the members already waiting (a later member never overtakes an earlier one); turned
   * off, it goes back to where it would be had it never had priority.
   */
  queuePriority(owner, priority) {
    if (!owner) return;
    for (const q of this.queue.filter(x => x.owner === owner && x.priority !== !!priority)) {
      this.queue.splice(this.queue.indexOf(q), 1);
      q.priority = !!priority;
      this.queuePlace(q);
    }
  }
  queueStatus(ticket) {
    this.pruneQueue();
    const i = this.queue.findIndex(q => q.ticket === ticket);
    if (i < 0) return { ticket, gone: true };
    this.queue[i].seen = Date.now();
    const cap = this.remote?.capacity();
    return { ticket, position: i + 1, waiting: this.queue.length, ready: i === 0 && this.hasSlot(),
      active: this.sessions.size + (cap?.active || 0), max: config.maxSessions + (cap?.max || 0),
      ...(this.queue[i].priority ? { priority: true } : {}) };
  }
  queueLeave(ticket) { this.queue = this.queue.filter(q => q.ticket !== ticket); }
  /** Throws { queue: true } unless this caller may take a slot now (no line, or it heads the line). */
  takeTurn(ticket, game) {
    this.pruneQueue();
    const i = ticket ? this.queue.findIndex(q => q.ticket === ticket) : -1;
    const ahead = i < 0 ? this.queue.length : i;
    if (ahead > 0 || !this.hasSlot(game)) {
      throw Object.assign(new Error('Every rig is busy right now. You are in line.'), { status: 429, queue: true });
    }
  }

  async init() {
    await this.ensureNetwork();
    // Clean up containers orphaned by a previous crash: only this instance's (a hub and a node on
    // the same host each have their own rose.instance label). The hub also removes containers from
    // before instance labels existed, by its own name prefix.
    const stale = await docker.listContainers({ all: true, filters: { label: [`rose.instance=${config.instanceId}`] } });
    if (!config.nodeMode) {
      const legacy = await docker.listContainers({ all: true, filters: { label: ['rose.session'] } });
      stale.push(...legacy.filter(c => !c.Labels?.['rose.instance'] && c.Names?.some(n => n.replace(/^\//, '').startsWith(config.containerPrefix))));
    }
    await Promise.all(stale.map(c => docker.getContainer(c.Id).remove({ force: true }).catch(() => {})));
    log(`instance ${config.instanceId}: ${stale.length ? `removed ${stale.length} stale session containers` : 'no stale session containers'}`);
    setInterval(() => this.reap(), 10_000).unref();
    this.fillPool();
  }

  async ensureNetwork() {
    const nets = await docker.listNetworks({ filters: { name: [config.network] } });
    if (!nets.some(n => n.Name === config.network)) await docker.createNetwork({ Name: config.network });
  }

  total() { return this.sessions.size + this.pool.length + this.booting; }

  async bootOne({ pool = false, image } = {}) {
    const s = new Session(crypto.randomBytes(5).toString('hex'), image || config.image);
    this.booting++;
    try {
      await s.boot({ pool });
      return s;
    } catch (e) {
      await s.destroy();
      throw e;
    } finally {
      this.booting--;
    }
  }

  async fillPool() {
    if (this.pool.length + this.booting >= config.poolSize || this.total() >= config.maxSessions) return;
    // A warm session is a luxury: only boot one while the host has memory to spare (counting what
    // grown sessions were promised). reap() calls this every 10 s, so the pool refills once memory
    // comes back. The loop below re-checks the counts after this await, so overlapping calls can't
    // boot more than poolSize.
    const freeMb = await availableMb().catch(() => 0);
    if (freeMb < config.memoryMb + config.poolMinFreeMb) {
      if (!this.poolHeld) log(`pool not refilled: ${Math.round(freeMb)} MB free, needs ${config.memoryMb + config.poolMinFreeMb} MB`);
      this.poolHeld = true;
      return;
    }
    this.poolHeld = false;
    while (this.pool.length + this.booting < config.poolSize && this.total() < config.maxSessions) {
      this.bootOne({ pool: true })
        .then(s => {
          this.pool.push(s);
          // Once its apps are disabled, swap its boot leftovers out, if nobody has claimed it yet.
          s.slimmed.then(() => { if (s.state === 'ready' && this.pool.includes(s)) return s.reclaim(); }).catch(() => {});
        })
        .catch(e => log('pool boot failed:', e.message));
    }
  }

  /** Refuse to boot a new session when the host is nearly out of memory (claiming a pooled one is fine). */
  async admit() {
    const freeMb = await availableMb();
    if (freeMb < config.memoryMb / 2 + config.hostReserveMb) {
      log(`refused a new session: ${Math.round(freeMb)} MB available`);
      throw Object.assign(new Error('The server is out of memory right now. You are in line.'), { status: 503, queue: true });
    }
  }

  /**
   * A session for a player: here, or on a Rose node (a RemoteSession), in the order the hub's
   * scheduler picks (nodes.js order()). `game`: library id the player is starting (some games can
   * only run here); `place`: 'local' | 'node:<id>' (the owner's test hook) forces one candidate.
   * Returns something with info(). Throws {queue: true} when no candidate has room.
   * `image`: the game needs another Android image than REDROID_IMAGE (its ARM translator): it runs
   * here, where that image is, in a session booted for it.
   */
  async create({ ticket, game, place, image } = {}) {
    if (!this.remote || image) return this.createLocal(ticket, { image });   // no nodes: exactly the local path
    const g = await this.remote.resolveGame(game);
    this.takeTurn(ticket, g);
    let last;
    for (const c of this.remote.order(g, place)) {
      try {
        if (c === 'local') return await this.createLocal(ticket, { turnTaken: true });
        const rs = await this.remote.create(c, { game: g });
        if (ticket) this.queueLeave(ticket);
        return rs;
      } catch (e) {
        // A full or failing node: try the next candidate. Locally, only "no room" moves on.
        if (c === 'local' && !e.queue) throw e;
        last = e;
      }
    }
    throw last?.queue ? last : queueError();
  }

  async createLocal(ticket, { turnTaken = false, image } = {}) {
    if (!turnTaken) this.takeTurn(ticket);
    // Warm sessions run REDROID_IMAGE: a game that needs another image gets a session of its own.
    const own = !!image && image !== config.image;
    let s = own ? null : this.pool.shift();
    if (s) {
      // Claimed from the pool: back to normal CPU priority (2622 shares = cgroup v2 weight 100, the default).
      await s.container.update({ CpuShares: 2622 }).catch(e => log(`session ${s.id}: could not restore CPU priority: ${e.message}`));
    } else {
      // All slots taken, one by a warm session nobody claimed: it makes way (the pool refills later).
      if (own && this.total() >= config.maxSessions && this.pool.length) await this.pool.shift().destroy();
      if (this.total() >= config.maxSessions) throw queueError();
      await serial(() => this.admit());
      s = await this.bootOne({ image: own ? image : undefined });
      if (own) log(`session ${s.id}: booted on ${image} for its game's ARM translator`);
    }
    if (ticket) this.queueLeave(ticket);   // only now: if admit() or the boot failed, it keeps its place
    this.sessions.set(s.id, s);
    s.once('dead', () => this.end(s.id));
    s.on('change', () => this.emit('change', s));
    try {
      await s.activate();
    } catch (e) {
      await this.end(s.id);
      throw e;
    }
    this.fillPool();
    this.emit('change', s);
    return s;
  }

  /** A local session (only these have adb/scrcpy). */
  get(id) { return this.sessions.get(id); }
  /** A local session or a RemoteSession on a node. */
  find(id) { return this.sessions.get(id) || this.remote?.get(id); }
  isRemote(id) { return !this.sessions.has(id) && !!this.remote?.get(id); }

  async end(id) {
    if (this.isRemote(id)) return this.remote.end(id);
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.destroy();
    this.emit('change', s);
    this.fillPool();
  }

  reap() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      const idle = s.viewers.size === 0 && now - s.lastSeen > config.idleTimeoutSec * 1000;
      // Viewers connected, but every one of them has had the page in the background this long.
      const hidden = s.hiddenSince > 0 && now - s.hiddenSince > config.hiddenTimeoutSec * 1000;
      const expired = now - s.activatedAt > config.maxSessionMin * 60_000;
      if (idle || hidden || expired) {
        log(`reaping session ${s.id} (${idle ? 'idle' : hidden ? 'hidden' : 'max time'})`);
        this.end(s.id);
      }
    }
    this.fillPool();
  }

  stats() {
    const local = {
      active: this.sessions.size, pooled: this.pool.length, booting: this.booting,
      max: config.maxSessions, queued: (this.pruneQueue(), this.queue.length), sessions: [...this.sessions.values()].map(s => s.info()),
    };
    if (!this.remote) return local;
    // Node capacity counts too (no node names, addresses or specs in these public stats).
    const cap = this.remote.capacity();
    return {
      ...local, active: local.active + cap.active, pooled: local.pooled + cap.pooled, booting: local.booting + cap.booting,
      max: local.max + cap.max, sessions: [...local.sessions, ...this.remote.infos()],
      hosts: { online: cap.online, slots: cap.max, free: cap.free },
    };
  }

  async shutdown() {
    this.remote?.shutdown();
    await Promise.all([...this.sessions.keys()].map(id => this.end(id)));
    await Promise.all(this.pool.splice(0).map(s => s.destroy()));
  }
}
