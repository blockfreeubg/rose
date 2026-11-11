// Game library: apks/library.json holds the entries. Files without an entry still show up:
// APKs in apks/ and console games in roms/<system>/ (bundles and Switch .nro files are imported
// once with their real name and icon).
//
// Entry: { id, title, category, cover?, pkg?, addedAt?, credit?, license?, source? } plus where
// the game comes from - either a file on this server or a download link (fetched when played):
//   Android apps:  apk (file name in apks/)                | apkUrl (+ apkName)
//   Console games: system ('switch') + rom (path in roms/) | system + romUrl (+ romPath: the file
//                  inside a .zip download, romName)
//   romTree      - with romUrl (a .zip): homebrew that needs its data files on the SD card. The whole
//                  zip is unpacked and copied onto the emulated SD card (Eden: sdmc:/), and romPath is
//                  the .nro to boot, relative to the zip root. true = the zip root is the SD card root;
//                  a folder name (e.g. "switch") = the zip root goes into that folder on the SD card
//                  (for zips whose readme says "extract into /switch/"). Examples:
//                  { system: 'switch', romUrl: '.../game.zip', romTree: true, romPath: 'switch/game/game.nro' }
//                  { system: 'switch', romUrl: '.../game.zip', romTree: 'switch', romPath: 'game/game.nro' }
//                    -> both boot sdmc:/switch/game/game.nro
//   sha256, size - of the download (sha256 is verified when given)
//   file         - optional file in files/ pushed to /sdcard/Download before launch (emulators)
//   pkg          - learned Android package name, cached after first install
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { PACKAGE_RE, isBundle, metadata } from './bundle.js';
import { SYSTEMS, systemFor, systemForFile } from './emulators.js';
import { nroInfo } from './nro.js';
import * as fetcher from './fetcher.js';
import * as assets from './assets.js';

const run = promisify(execFile);
const dbPath = () => path.join(config.apkDir, 'library.json');
export const coverDir = () => path.join(config.apkDir, 'covers');

let cache = null;
const importing = new Set();
let writing = Promise.resolve();
// Bumped on every change to library.json (GET /api/stats reports it as part of libraryVersion).
export let version = 0;

async function load() {
  if (!cache) cache = JSON.parse(await fs.readFile(dbPath(), 'utf8').catch(() => '[]'));
  return cache;
}

function save() {
  version++;
  // Serialize writes; write atomically via rename.
  writing = writing.then(async () => {
    const tmp = dbPath() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
    await fs.rename(tmp, dbPath());
  });
  return writing;
}

const titleFromFile = f => f.replace(PACKAGE_RE, '')
  .replace(/_apkmirror\.com$/i, '').replace(/^(?:com|org|net|io)\.(\w+)(?:\.\w+)*_/, '$1_')
  .replace(/[\s_\-]+(v\d+(\.\d+)*|\d+(\.\d+)+)([\s_\-.].*)?$/i, '')   // strip "-v1.2", "_2.650.123_arm64"
  .replace(/[_\-.]+/g, ' ').trim() || f;
const titleFromRom = f => path.basename(f).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\s*[[(][^\])]*[\])]/g, '')
  .replace(/[_\-.]+/g, ' ').trim() || path.basename(f);
const autoId = file => 'auto-' + crypto.createHash('sha1').update(file).digest('hex').slice(0, 10);
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; } };

/** File name of the game as installed/pushed (for display and to pick the installer). */
export function fileName(g) {
  if (g.rom) return path.basename(g.rom);
  if (g.romUrl) return path.basename(g.romName || g.romPath || fetcher.urlName(g.romUrl));
  if (g.apk) return g.apk;
  if (g.apkUrl) return g.apkName || fetcher.urlName(g.apkUrl);
  return '';
}

function formatOf(g, sys) {
  const ext = path.extname(fileName(g)).toLowerCase();
  if (sys) return `${sys.short} ${ext === '.nro' ? 'homebrew' : 'game'} (${ext || 'file'})`;
  return isBundle(fileName(g)) ? `Split bundle (${ext})` : 'APK';
}

/** ROM files under roms/<system>/ as paths relative to roms/ (e.g. "switch/game.nro"). */
async function scanRoms() {
  const out = [];
  for (const sys of Object.values(SYSTEMS)) {
    for (const e of await fs.readdir(path.join(config.romDir, sys.id), { withFileTypes: true }).catch(() => [])) {
      if (e.isFile() && sys.exts.includes(path.extname(e.name).toLowerCase())) out.push(`${sys.id}/${e.name}`);
    }
  }
  return out;
}

// ---- Node mode (a Rose node, config.nodeMode): the library is the hub's, never this machine's.
// node-agent.js loads it from the hub (/node-api/lib: only the fields needed to play, only games
// this node may run) and setRemote()s it; nothing is ever written back to the hub.
let remote = null;          // { version, games, at }
let remoteLoader = null;    // () => Promise<{ version, games }>
let remoteLoading = null;
/** node-agent.js: how to (re)load the hub's library. */
export function useRemote(loader) { remoteLoader = loader; }
/** node-agent.js: the hub's library arrived. */
export function setRemote({ version: v, games } = {}) {
  if (!Array.isArray(games)) return;
  const valid = games.filter(g => g && typeof g === 'object' && typeof g.id === 'string' && typeof g.title === 'string');
  remote = { version: v, games: valid.map(g => ({ category: 'Uncategorized', ...g, fileName: fileName(g), missing: false })), at: Date.now() };
  version++;
}
export const remoteVersion = () => remote?.version ?? null;
/** node-agent.js: the hub says its library changed. */
export const refreshRemote = () => reloadRemote();
function reloadRemote() {
  if (!remoteLoader) return Promise.resolve();
  remoteLoading ??= remoteLoader().then(setRemote, e => console.warn(`could not load the hub's library: ${e.message}`))
    .finally(() => { remoteLoading = null; });
  return remoteLoading;
}
async function remoteList() {
  if (!remote) await reloadRemote();
  return (remote?.games || []).map(g => ({ ...g }));
}

export async function list() {
  if (config.nodeMode) return remoteList();
  const entries = await load();
  const apks = (await fs.readdir(config.apkDir).catch(() => [])).filter(n => PACKAGE_RE.test(n));
  const listed = new Set(entries.map(e => e.apk).filter(Boolean));
  // Bundles dropped straight into apks/ carry their real name + icon: import them once as proper entries.
  for (const apk of apks.filter(a => !listed.has(a) && isBundle(a) && !importing.has(a))) {
    importing.add(apk);
    importBundle(apk).finally(() => importing.delete(apk));
  }
  const roms = await scanRoms();
  const listedRoms = new Set(entries.map(e => e.rom).filter(Boolean));
  for (const rom of roms.filter(r => !listedRoms.has(r) && !importing.has(r))) {
    importing.add(rom);
    importRom(rom).finally(() => importing.delete(rom));
  }
  const auto = [
    ...apks.filter(a => !listed.has(a)).map(apk => ({ id: autoId(apk), title: titleFromFile(apk), category: 'Uncategorized', apk, auto: true })),
    ...roms.filter(r => !listedRoms.has(r)).map(rom => {
      const sys = systemForFile(rom);
      return { id: autoId(rom), title: titleFromRom(rom), category: sys.short, system: sys.id, rom, auto: true };
    }),
  ];
  return Promise.all([...entries, ...auto].map(describe));
}

/** An entry as the UI sees it: where it comes from, its size, whether it can be played. */
async function describe(g) {
  const sys = g.system ? systemFor(g.system) : null;
  const local = g.rom ? path.join(config.romDir, g.rom) : g.apk ? path.join(config.apkDir, g.apk) : null;
  const url = g.romUrl || g.apkUrl || null;
  let size = g.size ?? null, missing = false, addedAt = g.addedAt || 0;
  if (local) {
    const st = await fs.stat(local).catch(() => null);
    size = st?.size ?? null;
    missing = !st;
    addedAt ||= st?.mtimeMs || 0;
  } else if (!url) {
    missing = true;
  }
  if (g.system && !sys) missing = true;
  return {
    ...g, size, missing, addedAt,
    coverUrl: g.cover ? `/covers/${encodeURIComponent(g.cover)}` : null,
    fileName: fileName(g),
    format: formatOf(g, sys),
    host: local ? null : hostOf(url),
    ...(sys ? { systemName: sys.name, emulator: sys.emulator, controls: sys.controls } : {}),
  };
}

/**
 * Keep list() from auto-importing a file (apk name, or rom path like "switch/x.nro") while a request
 * is adding it itself; otherwise a big bundle is unpacked twice and can end up with two entries.
 * Returns the function that lifts it.
 */
export function reserve(name) {
  importing.add(name);
  return () => importing.delete(name);
}

export async function get(id) {
  const g = (await list()).find(g => g.id === id);
  // Node: a game the hub added a moment ago (its {t:'lib'} may not have arrived yet).
  if (!g && config.nodeMode && Date.now() - (remote?.at || 0) > 5000) { await reloadRemote(); return (await list()).find(g => g.id === id); }
  return g;
}

/** Local copy of an entry's APK: { path, release }. Download-link entries are fetched first. */
export async function acquireApk(g) {
  if (g.apk) return assets.apk(g.apk, fileName(g));   // on a node: from the hub
  if (g.apkUrl) return fetcher.acquire(g.apkUrl, { sha256: g.sha256, size: g.size, name: fileName(g) });
  throw new Error('this entry has no APK');
}

/** romTree entries: the SD card folder the zip root goes into ('' = the SD card root), or null if invalid. */
export function treeDir(g) {
  if (g.romTree === true) return '';
  const d = typeof g.romTree === 'string' ? g.romTree.replace(/^\/+|\/+$/g, '') : null;
  if (d === '') return '';
  return d && /^[\w.\-/]+$/.test(d) && fetcher.safeInner(d) ? d : null;
}

/** romTree entries: where the game to boot lands, relative to the SD card root. */
export const treeRomPath = g => [treeDir(g), g.romPath].filter(Boolean).join('/');

/**
 * romTree entries: the entry's zip unpacked into a directory: { path (zip root), release, sha256 }.
 * Checks that romPath (the game to boot) is a regular file in it.
 */
export async function acquireRomTree(g) {
  if (!g.romUrl || !g.romTree) throw new Error('this entry has no game archive');
  if (treeDir(g) === null) throw new Error('this entry\'s romTree is not a valid SD card folder');
  if (!fetcher.safeInner(g.romPath)) throw new Error('this entry has no valid romPath (the game inside its archive)');
  const t = await fetcher.acquireTree(g.romUrl, { sha256: g.sha256 });
  const st = await fs.lstat(path.join(t.path, g.romPath)).catch(() => null);
  if (!st?.isFile()) { await t.release(); throw new Error(`"${g.romPath}" is not in the game's archive`); }
  return t;
}

/** Local copy of an entry's game file: { path, release }. */
export async function acquireRom(g) {
  if (g.rom) return assets.rom(g.rom, fileName(g));   // on a node: from the hub
  if (g.romUrl) return fetcher.acquire(g.romUrl, { sha256: g.sha256, inner: g.romPath, name: fileName(g) });
  throw new Error('this entry has no game file');
}

const SOURCE_KEYS = ['apk', 'apkUrl', 'apkName', 'system', 'rom', 'romUrl', 'romPath', 'romName', 'romTree', 'sha256', 'size', 'pkg', 'credit', 'license', 'source'];
const sameSource = (a, b) => (a.apk && a.apk === b.apk) || (a.rom && a.rom === b.rom)
  || (a.apkUrl && a.apkUrl === b.apkUrl) || (a.romUrl && a.romUrl === b.romUrl && (a.romPath || '') === (b.romPath || ''));

export async function add(fields) {
  const { title, category, file, cover } = fields;
  const entries = await load();
  const existing = entries.find(e => sameSource(e, fields) && !file && !e.file);
  const entry = existing || { id: crypto.randomBytes(6).toString('hex') };
  const sys = fields.system ? systemFor(fields.system) : null;
  Object.assign(entry, {
    title: title?.trim() || (sys ? titleFromRom(fileName(fields)) : titleFromFile(fileName(fields))),
    category: category?.trim() || sys?.short || 'Uncategorized',
    ...Object.fromEntries(SOURCE_KEYS.filter(k => fields[k] !== undefined && fields[k] !== null && fields[k] !== '').map(k => [k, fields[k]])),
    ...(file ? { file } : {}),
    ...(cover ? { cover } : {}),
  });
  if (!existing) { entry.addedAt = Date.now(); entries.push(entry); }
  await save();
  return entry;
}

/** Turn an auto entry into a stored one (so it can hold a learned pkg/cover). */
async function materialize(id) {
  const entries = await load();
  let e = entries.find(x => x.id === id);
  if (!e) {
    const g = (await list()).find(x => x.id === id && x.auto);
    if (!g) return null;
    e = { id: g.id, title: g.title, category: g.category, ...(g.apk ? { apk: g.apk } : { system: g.system, rom: g.rom }) };
    entries.push(e);
  }
  return e;
}

export async function update(id, patch) {
  if (config.nodeMode) {
    // Node: only its own copy (e.g. a learned pkg, for this node's next play). The hub never takes it.
    const e = remote?.games.find(g => g.id === id);
    if (e) for (const k of ['pkg']) if (patch[k] !== undefined) e[k] = patch[k];
    return e || null;
  }
  const e = await materialize(id);
  if (!e) return null;
  for (const k of ['title', 'category', 'cover', 'pkg', 'file', 'apk']) if (patch[k] !== undefined) e[k] = patch[k];
  // A bigger session for this game (index.js bigGame); 0 removes the setting.
  for (const k of ['memoryMb', 'cpus']) if (patch[k] !== undefined) { if (patch[k] > 0) e[k] = patch[k]; else delete e[k]; }
  // Its ARM translator (index.js imageFor); '' goes back to the default.
  if (patch.translator !== undefined) { if (patch.translator) e.translator = patch.translator; else delete e.translator; }
  await save();
  return e;
}

export async function remove(id) {
  const entries = await load();
  const i = entries.findIndex(e => e.id === id);
  if (i >= 0) {
    const [e] = entries.splice(i, 1);
    if (e.cover) await fs.rm(path.join(coverDir(), e.cover), { force: true });
    await save();
  }
  return i >= 0;
}

/** True if any stored entry still uses this local APK / ROM file. */
export async function inUse(field, value) {
  return (await load()).some(e => e[field] === value);
}

async function saveCover(bytes, ext) {
  const cover = crypto.randomBytes(6).toString('hex') + ext;
  await fs.mkdir(coverDir(), { recursive: true });
  await fs.writeFile(path.join(coverDir(), cover), bytes);
  return cover;
}

async function importBundle(apk) {
  try {
    const meta = await metadata(path.join(config.apkDir, apk));
    const entries = await load();
    if (entries.some(e => e.apk === apk)) return;
    const cover = meta.icon ? await saveCover(meta.icon, '.png') : null;
    entries.push({
      id: autoId(apk), title: meta.name || titleFromFile(apk), category: 'Uncategorized', apk,
      ...(cover ? { cover } : {}), ...(meta.pkg ? { pkg: meta.pkg } : {}), addedAt: Date.now(),
    });
    await save();
    console.log(`imported bundle ${apk} as "${meta.name || titleFromFile(apk)}"`);
  } catch (e) {
    console.warn(`could not read bundle ${apk}: ${e.message}`);
  }
}

/** Import a console game found in roms/: Switch homebrew carries its name, author and icon. */
async function importRom(rom) {
  try {
    const sys = systemForFile(rom);
    const meta = /\.nro$/i.test(rom) ? await nroInfo(path.join(config.romDir, rom)).catch(() => null) : null;
    const entries = await load();
    if (entries.some(e => e.rom === rom)) return;
    const cover = meta?.icon ? await saveCover(meta.icon, '.jpg') : null;
    entries.push({
      id: autoId(rom), title: meta?.title || titleFromRom(rom), category: sys.short, system: sys.id, rom,
      ...(cover ? { cover } : {}), ...(meta?.author ? { credit: meta.author } : {}), addedAt: Date.now(),
    });
    await save();
    console.log(`imported ${rom} as "${meta?.title || titleFromRom(rom)}"`);
  } catch (e) {
    console.warn(`could not read ${rom}: ${e.message}`);
  }
}

/**
 * What a downloaded/uploaded file is, judged by its contents (links often hide the extension):
 * { kind: 'apk'|'bundle'|'rom', ext, system?, inner? (a ROM inside a zip) } or null.
 */
export async function sniff(file) {
  const fh = await fs.open(file, 'r');
  const head = Buffer.alloc(0x110);
  try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); }
  if (head.toString('latin1', 0x10, 0x14) === 'NRO0') return { kind: 'rom', ext: '.nro', system: 'switch' };
  if (head.toString('latin1', 0, 4) === 'PFS0') return { kind: 'rom', ext: '.nsp', system: 'switch' };
  if (head.toString('latin1', 0x100, 0x104) === 'HEAD') return { kind: 'rom', ext: '.xci', system: 'switch' };
  if (head.toString('latin1', 0, 2) !== 'PK') return null;
  const { stdout } = await run('unzip', ['-Z1', file], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
  const names = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (names.includes('AndroidManifest.xml')) return { kind: 'apk', ext: '.apk' };
  if (names.some(n => /\.apk$/i.test(n))) {
    const ext = names.includes('info.json') ? '.apkm' : names.includes('manifest.json') ? '.xapk' : '.apks';
    return { kind: 'bundle', ext };
  }
  // The game inside a zip: only a regular file (not a symlink) whose path stays inside the
  // archive, so it can be unpacked (fetcher.extractEntry) and played.
  const entries = await fetcher.zipEntries(file).catch(() => []);
  const inner = entries.find(e => e.file && fetcher.safeInner(e.name) && systemForFile(e.name))?.name;
  if (inner) {
    const sys = systemForFile(inner);
    return { kind: 'rom', ext: path.extname(inner).toLowerCase(), system: sys.id, inner };
  }
  return null;
}

/** Title/icon for a new entry from its file: bundle info or .nro metadata. type: { kind, ext }. */
export async function fileMeta(file, { kind, ext } = {}) {
  if (kind === 'bundle') {
    const m = await metadata(file).catch(() => ({}));
    return { title: m.name, pkg: m.pkg, icon: m.icon, iconExt: '.png' };
  }
  if (kind === 'rom' && ext === '.nro') {
    const m = await nroInfo(file).catch(() => null);
    return { title: m?.title, credit: m?.author, icon: m?.icon, iconExt: '.jpg' };
  }
  return {};
}
export { saveCover };
