// Thin async wrapper over the adb CLI. Each Redroid container exposes adbd on :5555.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import * as bundle from './bundle.js';

const run = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;   // quote for the device shell

// Stock AOSP apps a game session never uses. Disabled ones can't be started by broadcasts or
// jobs, so they stop costing RAM and CPU in the background. Never list anything Android or the
// stream needs (webview, launcher (kiosk() turns it off itself), systemui, settings, IME, documentsui, media/download providers,
// packageinstaller, permissioncontroller, telephony, networkstack, bluetooth, provision).
const UNUSED_APPS = [
  'com.android.deskclock', 'com.android.calendar', 'com.android.providers.calendar', 'com.android.contacts',
  'com.android.gallery3d', 'com.android.music', 'com.android.camera2', 'com.android.printspooler',
  'com.android.printservice.recommendation', 'com.android.bips', 'com.android.dreams.basic',
  'com.android.dreams.phototable', 'com.android.dynsystem', 'com.android.egg', 'com.android.managedprovisioning',
  'com.android.onetimeinitializer', 'com.android.quicksearchbox', 'com.android.smspush',
  'com.android.statementservice', 'com.android.localtransport', 'com.android.wallpaperbackup',
  'com.android.wallpaper.livepicker', 'com.android.traceur', 'com.android.htmlviewer', 'org.chromium.webview_shell',
  'com.android.bookmarkprovider', 'com.android.simappdialog', 'com.android.hotspot2.osulogin', 'com.android.emergency',
];

// Framework dimens set to 0 by fabricated overlays (kiosk()): the status and navigation bars then
// take no space and draw nothing, in every app, with no reboot or SystemUI restart.
const BAR_DIMENS = ['navigation_bar_height', 'navigation_bar_frame_height', 'navigation_bar_height_landscape',
  'status_bar_height_portrait', 'status_bar_height_landscape'];
// StatusBarManager disable flags: no home/recents buttons, no notification shade, no icons.
const DISABLE_FLAGS = 'home recents notification-peek statusbar-expansion system-icons clock notification-icons search';

/** True for an activity that is a home screen (the launcher, or Android's fallback home). */
export const isHome = top => !!top && (top.pkg === 'com.android.launcher3' || /FallbackHome$/.test(top.activity));

export class Adb {
  constructor(serial) {
    this.serial = serial; // "host:5555"
  }

  async raw(args, { timeout = 60_000 } = {}) {
    const { stdout } = await run('adb', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }

  cmd(args, opts) {
    return this.raw(['-s', this.serial, ...args], opts);
  }

  shell(command, opts) {
    return this.cmd(['shell', command], opts);
  }

  /** Run a shell script as root (Redroid images are userdebug builds with su). */
  root(script, opts) {
    return this.shell(`su 0 sh -c ${q(script)}`, opts);
  }

  async connect() {
    const out = await this.raw(['connect', this.serial], { timeout: 5000 });
    if (!/connected/.test(out) || /failed|refused|unable/i.test(out)) throw new Error(out);
  }

  async disconnect() {
    await this.raw(['disconnect', this.serial], { timeout: 5000 }).catch(() => {});
  }

  async waitForBoot(timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      try {
        await this.connect();
        if ((await this.shell('getprop sys.boot_completed', { timeout: 5000 })) === '1') return;
      } catch { /* not up yet */ }
      await sleep(1000);
    }
    throw new Error(`Android did not boot within ${timeoutSec}s`);
  }

  async listThirdPartyPackages() {
    const out = await this.shell('pm list packages -3');
    return new Set(out.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean));
  }

  async abiList() {
    return (await this.shell('getprop ro.product.cpu.abilist')).split(',').map(s => s.trim()).filter(Boolean);
  }

  /** Installs an .apk or a split bundle (.apkm/.apks/.xapk); returns newly-appeared package names. */
  async install(file) {
    const before = await this.listThirdPartyPackages();
    if (await bundle.isBundleFile(file)) await this.installBundle(file);
    else {
      const out = await this.cmd(['install', '-r', '-g', file], { timeout: 10 * 60_000 }).catch(e => { throw installError(e); });
      if (!/Success/.test(out)) throw installError({ message: out });
    }
    const after = await this.listThirdPartyPackages();
    const added = [...after].filter(p => !before.has(p));
    await this.prepareAppDirs(added);
    return added;
  }

  /**
   * Create each app's Android/data and Android/obb folders up front. Android normally has vold
   * create them, but vold also sets a disk-quota project ID, which this host's container
   * filesystem rejects; the app then gets null from getExternalFilesDir() and many apps
   * (Eden included) crash on start. Android skips vold when the folder already exists.
   */
  async prepareAppDirs(pkgs) {
    const valid = pkgs.filter(p => /^[\w.]+$/.test(p));
    if (!valid.length) return;
    await this.root(valid.map(p => [
      `uid=$(stat -c %u /data/data/${p} 2>/dev/null) && {`,
      `  for d in /data/media/0/Android/data/${p} /data/media/0/Android/data/${p}/files /data/media/0/Android/data/${p}/cache; do mkdir -p $d; chown $uid:ext_data_rw $d; chmod 2770 $d; done`,
      `  d=/data/media/0/Android/obb/${p}; mkdir -p $d; chown $uid:ext_obb_rw $d; chmod 2770 $d`,
      '}',
    ].join('\n')).join('\n')).catch(e => console.warn(`[${this.serial}] could not prepare app folders: ${e.message.split('\n')[0]}`));
  }

  /**
   * True if this (non-root) shell can really open /dev/uhid, which the virtual gamepad needs.
   * The node can exist while the host hasn't loaded the uhid module (open fails with ENODEV):
   * sending a gamepad to scrcpy then would crash its control channel and end the session.
   */
  async uhidReady() {
    return (await this.shell("sh -c 'exec 3<>/dev/uhid' 2>/dev/null && echo ok").catch(() => '')) === 'ok';
  }

  async installBundle(file) {
    const b = await bundle.extract(file);
    try {
      const apks = bundle.selectApks(b.apks, await this.abiList());
      const out = await this.cmd(['install-multiple', '-r', '-g', ...apks], { timeout: 15 * 60_000 }).catch(e => { throw installError(e); });
      if (!/Success/.test(out)) throw installError({ message: out });
      // XAPK games may carry OBB data: Android/obb/<pkg>/main.N.<pkg>.obb
      for (const obb of b.obbs) await this.pushObb(obb, path.basename(path.dirname(obb)));
    } finally {
      await b.cleanup();
    }
  }

  /**
   * Put an OBB file where its game looks for it. `adb push` straight to /sdcard/Android/obb/<pkg>
   * fails here ("secure_mkdirs failed: Operation not permitted"): only vold may create that folder,
   * and vold can't on this host (see prepareAppDirs). So: push to /data/local/tmp, then as root
   * create the folder the way vold would and move the file in (a rename on the same /data volume,
   * so a multi-GB OBB is never copied twice), owned by the game with group ext_obb_rw.
   */
  async pushObb(local, pkg) {
    const name = path.basename(local);
    if (!/^[\w.]+$/.test(pkg) || !/^[\w.-]+$/.test(name)) throw new Error(`bad OBB path: ${pkg}/${name}`);
    const tmp = `/data/local/tmp/rose-${Date.now().toString(36)}.obb.part`;
    await this.push(local, tmp);
    try {
      await this.root([
        `uid=$(stat -c %u /data/data/${pkg}) || exit 1`,
        `d=/data/media/0/Android/obb/${pkg}`,
        'mkdir -p $d && chown $uid:ext_obb_rw $d && chmod 2770 $d',
        `mv ${tmp} $d/${name} && chown $uid:ext_obb_rw $d/${name} && chmod 660 $d/${name}`,
      ].join('\n'), { timeout: 5 * 60_000 });
    } catch (e) {
      await this.shell(`rm -f ${tmp}`).catch(() => {});
      throw new Error(`could not install the game's data file ${name}: ${e.message.split('\n')[0]}`);
    }
  }

  push(local, remote) {
    return this.cmd(['push', local, remote], { timeout: 30 * 60_000 });
  }

  /** Launch an app's main activity and verify it is still alive a few seconds later. */
  async launch(pkg) {
    if (!/^[\w.]+$/.test(pkg)) throw new Error('bad package name');
    const comp = (await this.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`))
      .split('\n').pop().trim();
    if (!comp.includes('/')) throw new Error(`${pkg} has no launchable activity`);
    await this.startIntent(`am start -n ${comp}`, pkg);
  }

  /**
   * Run an `am start …` command for `pkg` and verify the app is still alive a few seconds later.
   * If `activity` is given, it must also be the one in front (e.g. an emulator's game screen).
   */
  async startIntent(command, pkg, activity) {
    // A pinned task refuses any other app's start ("Lock Task Mode violation"): unpin first.
    await this.unpin();
    await this.shell('logcat -b crash -c').catch(() => {});
    // No `am start -W`: emulator screens never report "fully drawn", so -W hangs until the timeout.
    const out = await this.shell(command, { timeout: 60_000 });
    if (/^Error:/m.test(out)) throw new Error(`could not start ${pkg}: ${out.match(/^Error:.*$/m)[0]}`);
    // Poll: the app must be alive and (if given) `activity` in front. Give slow starts up to 20 s.
    let top = '';
    for (let t = 0; t < 20; t++) {
      await sleep(1000);
      const pid = await this.shell(alivePids(pkg)).catch(() => '');
      if (!pid) {
        if (t < 3) continue;                      // may not have forked yet
        const crash = await this.shell('logcat -d -b crash').catch(() => '');
        throw new Error(explainCrash(pkg, crash));
      }
      if (!activity) { if (t >= 3) return; continue; }   // alive for a few seconds: good enough
      top = await this.shell('dumpsys activity activities | grep -m1 mResumedActivity').catch(() => '');
      if (top.includes(activity)) return;
    }
    throw new Error(`${pkg} started but did not open the game (the file may be unsupported or need keys/firmware)`);
  }

  /** The activity in front: { pkg, activity, task } or null (nothing resumed, e.g. no home and no game). */
  async resumed() {
    const line = await this.shell('dumpsys activity activities 2>/dev/null | grep -m1 mResumedActivity; true', { timeout: 10_000 });
    const m = line.match(/ActivityRecord\{\S+ u\d+ ([\w.]+)\/(\S+) t(\d+)/);
    return m ? { pkg: m[1], activity: m[2], task: Number(m[3]) } : null;
  }

  /**
   * One cheap look for the game watchdog (sessions.js): is `pkg` alive, and what is in front?
   * Returns { alive, top } where top is as resumed() (null = nothing resumed).
   */
  async gameState(pkg) {
    if (!/^[\w.]+$/.test(pkg)) throw new Error('bad package name');
    const out = await this.shell(`${alivePids(pkg)}; echo @; dumpsys activity activities 2>/dev/null | grep -m1 mResumedActivity; true`, { timeout: 10_000 });
    const [pid, line = ''] = out.split('@');
    const m = line.match(/ActivityRecord\{\S+ u\d+ ([\w.]+)\/(\S+) t(\d+)/);
    return { alive: /\d/.test(pid), top: m ? { pkg: m[1], activity: m[2], task: Number(m[3]) } : null };
  }

  /**
   * Pin (lock task) the game's task once `pkg` is in front, so Home, Recents and Back at its root
   * do nothing. Activities the game opens in its own task (permission dialogs, pickers, the IME)
   * still work; a new task (e.g. an external browser) is refused. Best effort: false if `pkg`
   * never came to the front within ~10 s.
   */
  async pin(pkg) {
    for (let t = 0; t < 20; t++) {
      const top = await this.resumed().catch(() => null);
      if (top?.pkg === pkg) {
        // Always prints "Activity manager is not in lockTaskMode"; that text means nothing.
        await this.root(`am task lock ${top.task}`, { timeout: 10_000 });
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  unpin() {
    return this.root('am task lock stop', { timeout: 10_000 }).catch(() => {});
  }

  /**
   * Make the device show only the game: zero-height status and navigation bars, no notification
   * shade or home/recents buttons, no "App pinned" toasts, and no home screen at all (with no
   * game in front the screen is black). Run once per container, after boot completed (Android
   * needs a home screen to finish booting). The disable flags must be sent BEFORE the overlays
   * are enabled, or the zero-height status bar keeps a stale clock on screen.
   */
  async kiosk() {
    await this.root([
      ...BAR_DIMENS.map(r => `cmd overlay fabricate --target android --name rz_${r} android:dimen/${r} 0x05 0x00000001`),
      `cmd statusbar send-disable-flag ${DISABLE_FLAGS}`,
      ...BAR_DIMENS.map(r => `cmd overlay enable com.android.shell:rz_${r}`),
      // Pinning shows "App pinned" / "To unpin this app..." toasts. (This also hides apps' text toasts.)
      'appops set com.android.systemui TOAST_WINDOW ignore',
      // No launcher (that also removes Recents, which lives in it), and no fallback home either.
      'pm disable-user --user 0 com.android.launcher3',
      'pm disable com.android.settings/.FallbackHome',
      'true',
    ].join(' >/dev/null 2>&1\n') + ' >/dev/null 2>&1', { timeout: 60_000 });
  }

  async forward(remoteSocket) {
    const port = await this.cmd(['forward', 'tcp:0', remoteSocket]);
    return Number(port);
  }

  removeForward(port) {
    return this.cmd(['forward', '--remove', `tcp:${port}`]).catch(() => {});
  }

  /** Long-running shell process (used for scrcpy-server). */
  spawnShell(command) {
    return spawn('adb', ['-s', this.serial, 'shell', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Strip Android down for a single-game session: fewer animations, fewer background services. */
  async optimize() {
    const cmds = [
      // Keep fewer idle apps cached in memory (default 32), and let ActivityManager compact the
      // ones it keeps. The first line stops a device_config sync from undoing the two puts.
      'device_config set_sync_disabled_for_tests persistent',
      'device_config put activity_manager max_cached_processes 8',
      'device_config put activity_manager use_compaction true',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put global stay_on_while_plugged_in 7',
      'settings put system screen_off_timeout 2147483647',
      'settings put global package_verifier_enable 0',
      'settings put global verifier_verify_adb_installs 0',
      'settings put secure show_ime_with_hard_keyboard 0',
      // Don't cover fullscreen games with the "Viewing full screen, swipe down to exit" notice.
      'settings put secure immersive_mode_confirmations confirmed',
      'svc power stayon true',
    ];
    await this.shell(cmds.join(' ; ')).catch(() => {});
    // Let the scrcpy server (shell user) create virtual gamepads, as stock Android allows. In a
    // container /dev/uhid is root-only. This only changes the container's own device node.
    await this.root('chown uhid:uhid /dev/uhid && chmod 660 /dev/uhid').catch(() => {});
    await this.kiosk().catch(e => console.warn(`[${this.serial}] could not hide the system UI: ${e.message.split('\n')[0]}`));
  }

  /** Disable the stock apps in UNUSED_APPS (one root shell; ones this image lacks are skipped). Callers don't await it. */
  disableUnusedApps() {
    return this.root(`for p in ${UNUSED_APPS.join(' ')}; do pm disable-user --user 0 $p; done >/dev/null 2>&1; true`, { timeout: 120_000 });
  }
}

// Turn adb/PackageManager failures into messages a player can act on.
function installError(e) {
  const msg = `${e.stdout || ''} ${e.stderr || ''} ${e.message || ''}`;
  const code = msg.match(/INSTALL_[A-Z_]+/)?.[0];
  const hints = {
    INSTALL_FAILED_NO_MATCHING_ABIS: 'this APK has no native code for this device; use a bundle/APK that includes x86_64 or arm64 libraries',
    INSTALL_FAILED_MISSING_SPLIT: 'this is only part of a split app; upload the full .apkm/.apks/.xapk bundle instead of base.apk',
    INSTALL_FAILED_OLDER_SDK: 'the app needs a newer Android version than this session runs (Android 12)',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: 'not enough storage in the session',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'the APK is unsigned or corrupt',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'a differently-signed version is already installed',
  };
  return new Error(code ? `Install failed (${code}): ${hints[code] || 'see server logs'}` : `Install failed: ${msg.trim().split('\n').pop()}`);
}

// Shell command printing the pids of `pkg`'s processes: its main one and any `pkg:name` process
// (an app whose activities all run in android:process=":launcher" has no process named `pkg`).
const alivePids = pkg => `ps -A -o PID=,NAME= | grep -E ' ${pkg.replace(/\./g, '\\.')}(:[^ ]*)?$' | awk '{print $1}'`;

function explainCrash(pkg, crash) {
  if (/UnsatisfiedLinkError|couldn't find "lib|dlopen failed/i.test(crash)) {
    return `${pkg} crashed on launch: its native libraries are missing. It is probably a split app: upload the full .apkm/.apks/.xapk bundle, not just base.apk.`;
  }
  const line = crash.split('\n').find(l => /Exception|Error/.test(l));
  return `${pkg} closed right after launching${line ? `: ${line.replace(/^.*?E AndroidRuntime:\s*/, '').trim()}` : ' (it may be blocking emulators, or needs Google Play Services)'}`;
}
