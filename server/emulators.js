// Emulated consoles. A library entry with { system, rom | romUrl } is played by installing that
// system's emulator (an APK in apks/, or its official download), copying the game into the
// emulator's own storage and opening it with an intent that boots straight into the game.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import * as fetcher from './fetcher.js';

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;   // quote for the device shell

const EDEN = 'dev.eden.eden_emulator';
const EDEN_DATA = `/data/media/0/Android/data/${EDEN}`;   // backs Eden's getExternalFilesDir()
const EDEN_FILES = `${EDEN_DATA}/files`;

export const SYSTEMS = {
  switch: {
    id: 'switch',
    name: 'Nintendo Switch',
    short: 'Switch',
    emulator: 'Eden',
    pkg: EDEN,
    exts: ['.nro', '.nsp', '.xci'],
    controls: 'gamepad',     // Eden only reads controllers: the player maps the keyboard to a virtual pad
    // Eden's official x86_64 build (its "chromeos" APK) runs natively in Redroid, no ARM translation.
    // To update, drop a newer x86_64 build into apks/ as Eden*.apk: a local file wins over the download.
    apk: {
      local: /^eden.*\.apk$/i,
      url: 'https://stable.eden-emu.dev/v0.2.1/Eden-Android-v0.2.1-chromeos.apk',
      sha256: '554353f78e39bb486fa92c7524c2ca21890cd74b04ba6ef45f0f57b6683af6cc',
    },
    resources: () => ({ memoryMb: config.switchMemoryMb, cpus: config.switchCpus }),

    /**
     * Once per session, after Eden is installed: skip its first-run wizard, hide the FPS and
     * device-info text it draws over games, and copy in your own keys/firmware from roms/switch/keys and
     * roms/switch/firmware (needed only for your own game dumps; homebrew runs without them).
     */
    async prepare(adb) {
      await adb.root([
        'set -e',
        `p=${EDEN}`,
        'uid=$(stat -c %u /data/data/$p)',
        `f=${EDEN_FILES}`,
        'mkdir -p $f/config $f/keys $f/roms',
        `[ -s $f/config/config.ini ] || printf '%s\\n' '[Overlay]' 'show_performance_overlay\\default=false' 'show_performance_overlay=false' 'show_soc_overlay\\default=false' 'show_soc_overlay=false' > $f/config/config.ini`,
        'sp=/data/data/$p/shared_prefs; x=$sp/${p}_preferences.xml',
        `if ! grep -q FirstApplicationLaunch $x 2>/dev/null; then mkdir -p $sp; printf '%s\\n' "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>" '<map>' '    <boolean name="FirstApplicationLaunch" value="false" />' '</map>' > $x; chown $uid:$uid $sp $x; chmod 771 $sp; chmod 660 $x; fi`,
      ].join('\n'));

      const own = path.join(config.romDir, 'switch');
      const keys = (await fs.readdir(path.join(own, 'keys')).catch(() => [])).filter(n => /^[\w.\-]+\.keys$/i.test(n));
      for (const k of keys) await adb.push(path.join(own, 'keys', k), `/data/local/tmp/rose-keys-${k}`);
      const fw = (await fs.readdir(path.join(own, 'firmware')).catch(() => [])).filter(n => /^[\w.\-]+\.nca$/i.test(n));
      if (fw.length) {
        await adb.shell('rm -rf /data/local/tmp/rose-fw && mkdir -p /data/local/tmp/rose-fw');
        for (const n of fw) await adb.push(path.join(own, 'firmware', n), `/data/local/tmp/rose-fw/${n}`);
      }
      await adb.root([
        'set -e',
        `f=${EDEN_FILES}`,
        ...keys.map(k => `mv -f /data/local/tmp/rose-keys-${k} $f/keys/${k}`),
        ...(fw.length ? ['mkdir -p $f/nand/system/Contents/registered', 'mv -f /data/local/tmp/rose-fw/* $f/nand/system/Contents/registered/', 'rm -rf /data/local/tmp/rose-fw'] : []),
        ...ownEdenFiles(),
      ].join('\n'));
    },

    /** Copy a game file into Eden's storage as `name` (a safe file name). */
    async pushRom(adb, local, name) {
      const tmp = `/data/local/tmp/rose-rom-${name}`;
      await adb.push(local, tmp);
      await adb.root(['set -e', `f=${EDEN_FILES}`, 'mkdir -p $f/roms', `mv -f ${q(tmp)} $f/roms/${q(name)}`, ...ownEdenFiles()].join('\n'));
    },

    /**
     * Files that belong on the emulated SD card (romTree entries): the unpacked archive `local` is
     * copied into sdmc/<dir> (sdmc/ is Eden's SD card root; dir '' = the root itself), merging with
     * what's there. `tag` names this exact tree; a session that already has it (e.g. reused for
     * the same game) skips the copy.
     */
    hasTree(adb, tag) {
      return adb.root(`cat ${q(`${EDEN_FILES}/.rose-trees/${tag}`)} 2>/dev/null || true`).then(out => out.trim() === 'ok', () => false);
    },
    async pushTree(adb, local, tag, dir = '') {
      const tmp = `/data/local/tmp/rose-tree-${tag}`;
      await adb.shell(`rm -rf ${q(tmp)}`);
      await adb.push(local, tmp);
      await adb.root([
        'set -e', `f=${EDEN_FILES}`, `t=${q(tmp)}`,
        `d=$f/sdmc/${q(dir)}`,
        'mkdir -p "$d" $f/.rose-trees',
        'cp -R $t/. "$d"/',
        'rm -rf $t',
        `echo ok > $f/.rose-trees/${tag}`,
        ...ownEdenFiles(),
      ].join('\n'));
    },

    /**
     * Right before a launch. On a real Switch the homebrew menu starts a game with its own folder
     * (e.g. sdmc:/switch/game/) as the working directory; Eden passes no such path, so a game
     * starts in sdmc:/ and ports that load data relative to it ("./data") find nothing. For a game
     * on the SD card (`file` = sdmc/...), link every entry of its folder into the SD card root
     * (never over a real file there). The links of the previous game are removed first; Rose is
     * the only one making symlinks there (a game can't), so every symlink at the root is ours.
     * Eden is stopped first: a game sent to a running Eden makes it quit instead of switching.
     */
    async beforeLaunch(adb, file) {
      const dir = file.startsWith('sdmc/') ? path.posix.dirname(file.slice(5)) : '.';
      await adb.root([
        `am force-stop ${EDEN}`,
        `s=${EDEN_FILES}/sdmc`,
        '[ -d $s ] || exit 0',
        'find $s -maxdepth 1 -type l -exec rm -f {} +',
        ...(dir !== '.' ? [
          `d=${q(dir)}`,
          'for e in "$s/$d"/* "$s/$d"/.[!.]*; do [ -e "$e" ] || continue; n=${e##*/}; [ -e "$s/$n" ] || [ -L "$s/$n" ] || ln -s "$d/$n" "$s/$n"; done',
          `uid=$(stat -c %u /data/data/${EDEN}); find $s -maxdepth 1 -type l -exec chown -h $uid:ext_data_rw {} +`,
        ] : []),
      ].join('\n'));
    },

    // Eden opens content:// URIs (its own document provider serves its user dir), which needs no
    // storage permission and boots straight into emulation without its game list.
    // `file` is the game's path in that dir: roms/<name> (pushRom) or sdmc/<romPath> (pushTree).
    activity: 'org.yuzu.yuzu_emu.activities.EmulationActivity',
    launchCommand(file) {
      const uri = `content://${EDEN}.user/document/${encodeURIComponent(`root/${file}`)}`;
      return `am start -a android.intent.action.VIEW -t application/octet-stream -d ${q(uri)} -n ${EDEN}/${this.activity}`;
    },
  },
};

// Files root writes into Eden's storage must belong to Eden's user, like the ones it creates.
const ownEdenFiles = () => [
  `uid=$(stat -c %u /data/data/${EDEN})`,
  `chown -R $uid:ext_data_rw ${EDEN_DATA}`,
  `find ${EDEN_DATA} -type d -exec chmod 2770 {} +`,
  `find ${EDEN_DATA} -type f -exec chmod 660 {} +`,
];

export const systemFor = id => SYSTEMS[id] || null;
export const byPackage = pkg => Object.values(SYSTEMS).find(s => s.pkg === pkg) || null;
/** Which system plays a file, judging by its extension (e.g. .nro -> switch). */
export const systemForFile = name => Object.values(SYSTEMS).find(s => s.exts.includes(path.extname(String(name)).toLowerCase())) || null;

/** The emulator APK: a local copy in apks/ if there is one, otherwise its official download. */
export async function acquireEmulatorApk(sys) {
  // Newest version wins: compare digit runs as numbers, so v0.10.0 beats v0.2.1 (a plain sort wouldn't).
  const local = (await fs.readdir(config.apkDir).catch(() => [])).filter(n => sys.apk.local.test(n))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })).pop();
  if (local) return { path: path.join(config.apkDir, local), release: async () => {} };
  return fetcher.acquire(sys.apk.url, { sha256: sys.apk.sha256, name: fetcher.urlName(sys.apk.url) });
}
