// On-demand downloads for library entries that live on external sites (apkUrl / romUrl), so the
// server doesn't have to keep every APK and ROM on disk. Downloads go into a cache capped at
// CACHE_MB, least recently used first out; a file bigger than the cap (or any file with
// CACHE_MB=0) is deleted as soon as the session that needed it has installed it.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as apkpure from './apkpure.js';

const run = promisify(execFile);
const MB = 1024 * 1024;
const IDLE_MS = 60_000;          // give up on a download that stalls this long
const PART = '.download.part';
const XPART = '.extract.part';   // a game being unpacked from its zip (any *.part = unfinished)
const SUM = '.sha256';           // sha256 of the download, so add-by-link can record it
const SPACE_EVERY = 256 * MB;    // re-check free space this often while writing
const inflight = new Map();      // cache key -> Promise (the last job for it; jobs for one key run one at a time)
const inUse = new Map();         // cache key -> number of sessions using it (never evicted)
const names = new Map();         // cached file path -> number of callers using that name

export const isUrl = s => /^https?:\/\/\S+$/i.test(String(s || ''));
const safeName = n => String(n || '').split(/[\\/]/).pop().replace(/[^\w.\-]/g, '_').slice(-120) || 'download';
const keyOf = (url, inner) => crypto.createHash('sha256').update(`${url}\n${inner || ''}`).digest('hex').slice(0, 24);
const hostOf = url => { try { return new URL(url).host; } catch { return url; } };
/** A path inside an archive that stays inside wherever it's unpacked. */
export const safeInner = p => !!p && !path.isAbsolute(p) && !String(p).split(/[\\/]/).includes('..');
// unzip reads member names as wildcard patterns: "Game [0100ABC][v0].nsp" (the usual Switch dump
// name) would match nothing, and an entry named "*.nro" would match every .nro. Escape them.
const unzipLiteral = p => p.replace(/[[\]*?\\]/g, '\\$&');
const isRegular = f => fs.lstat(f).then(st => st.isFile(), () => false);   // not a symlink

/** The file name a link points at (last path segment), e.g. to tell an .apkm from an .nro. */
export function urlName(url) {
  try { return safeName(decodeURIComponent(new URL(url).pathname)); } catch { return 'download'; }
}

/**
 * A local copy of `url` (or of `inner`, a file inside the zip archive at `url`), downloaded on
 * first use. Resolves to { path, release, sha256 }; call release() when done so the cache can make
 * room. sha256 is the download's checksum (of the archive, for `inner`), when known.
 *   sha256 - expected checksum of the download (verified when given)
 *   size   - with sha256: the download's expected size. A reply announcing another size is a
 *            different file (a mirror sometimes ignores the version a link asks for): it is asked
 *            again a few times instead of being downloaded only to fail the checksum.
 *   name   - file name to store it under (keep the extension: installers look at it)
 *   from   - with `inner`: a local copy of the archive to unpack instead of downloading it again
 *   headers - extra request headers (a Rose node's bearer token for its hub's /node-api/files). With
 *            an authorization header redirects are refused, so the token can't follow one elsewhere.
 *            Never part of the cache key or path.
 */
export async function acquire(url, { sha256, size, name, inner, from, headers } = {}) {
  if (!isUrl(url)) throw new Error(`not a download link: ${url}`);
  if (inner && !safeInner(inner)) throw new Error(`bad archive path: ${inner}`);
  const key = keyOf(url, inner);
  const dir = path.join(config.cacheDir, key);
  const file = path.join(dir, safeName(name || (inner ? inner : urlName(url))));
  inUse.set(key, (inUse.get(key) || 0) + 1);
  names.set(file, (names.get(file) || 0) + 1);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const n = (inUse.get(key) || 1) - 1;
    if (n > 0) inUse.set(key, n); else inUse.delete(key);
    const m = (names.get(file) || 1) - 1;
    if (m > 0) names.set(file, m);
    else {
      names.delete(file);
      // A name ensure() hard-linked next to another one: drop it once nobody uses it, so the
      // copy isn't counted twice by evict() (the data stays under the other name).
      await queue(key, async () => {
        if (names.has(file)) return;
        const st = await fs.lstat(file).catch(() => null);
        if (st?.isFile() && st.nlink > 1) await fs.rm(file, { force: true });
      }).catch(() => {});
    }
    await evict();
  };
  try {
    // Jobs for one key run one after another, and each makes sure *its* file name exists: two
    // callers can want the same download under different names (add-by-link vs. play), and a
    // shared job used to hand the second one a path that was never written.
    const sum = await queue(key, () => ensure(url, dir, file, { sha256, size, inner, from, headers }));
    const now = new Date();
    await fs.utimes(file, now, now).catch(() => {});   // last use, for LRU eviction
    return { path: file, release, sha256: sum || undefined };
  } catch (e) {
    await release();
    throw e;
  }
}

const TREE = 'tree';              // an unpacked zip (acquireTree), inside its cache entry
const TREE_TAG = '\0tree';        // cache key suffix for unpacked trees (a real path can't hold \0)
const MAX_TREE_FILES = 20000;

/**
 * A whole zip archive at `url` unpacked into a directory, downloaded and unpacked on first use
 * and cached like other downloads (keyed by the link). Resolves to { path (the directory: the
 * zip's root), release, sha256, key }. Unpacking is as strict as for single files: no absolute
 * or "../" paths, no symlinks or other special entries, every file capped at its declared size,
 * and the total capped at MAX_DOWNLOAD_MB.
 */
export async function acquireTree(url, { sha256 } = {}) {
  if (!isUrl(url)) throw new Error(`not a download link: ${url}`);
  const key = keyOf(url, TREE_TAG);
  const dir = path.join(config.cacheDir, key);
  const tree = path.join(dir, TREE);
  inUse.set(key, (inUse.get(key) || 0) + 1);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const n = (inUse.get(key) || 1) - 1;
    if (n > 0) inUse.set(key, n); else inUse.delete(key);
    await evict();
  };
  try {
    const sum = await queue(key, async () => {
      const known = await fs.readFile(path.join(dir, SUM), 'utf8').then(s => s.trim(), () => null);
      const fresh = !(sha256 && known && known !== sha256.toLowerCase());
      if (fresh && await fs.lstat(tree).then(st => st.isDirectory(), () => false)) return known;
      if ((inUse.get(key) || 0) > 1 && await fs.lstat(tree).then(() => true, () => false)) {
        throw Object.assign(new Error('this download is in use by another session; try again when it ends'), { status: 409 });
      }
      return download(url, dir, tree, { sha256, tree: true });
    });
    const now = new Date();
    await fs.utimes(tree, now, now).catch(() => {});   // last use, for LRU eviction
    return { path: tree, release, sha256: sum || undefined, key };
  } catch (e) {
    await release();
    throw e;
  }
}

/**
 * Unpack every file of `zip` into the new directory `dest`, safely: names are checked before
 * anything is written, each file is streamed out by extractEntry (capped at its declared size),
 * and directories are created by Rose, never taken from the archive.
 */
export async function extractTree(zip, dest) {
  const entries = await zipEntries(zip).catch(() => { throw new Error('the download is not a readable zip archive'); });
  const files = [];
  let total = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) {                       // a directory entry
      if (!safeInner(e.name.slice(0, -1) || 'x')) throw new Error(`bad archive path: ${e.name}`);
      continue;
    }
    if (!safeInner(e.name) || e.name.includes('\\')) throw new Error(`bad archive path: ${e.name}`);
    if (!e.file) throw new Error(`"${e.name}" in the archive is a link or special file`);
    files.push(e);
    total += e.size;
  }
  if (!files.length) throw new Error('the archive is empty');
  if (files.length > MAX_TREE_FILES) throw new Error(`the archive holds too many files (${files.length})`);
  if (total > maxBytes()) throw tooBig(`the unpacked archive (${Math.round(total / MB)} MB)`);
  await checkSpace(total);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  const root = path.resolve(dest);
  for (const e of files) {
    const out = path.resolve(root, e.name);
    if (!out.startsWith(root + path.sep)) throw new Error(`bad archive path: ${e.name}`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    // A file and a directory of the same name, or the same name twice: refuse rather than guess.
    if (await fs.lstat(out).then(() => true, () => false)) throw new Error(`"${e.name}" appears twice in the archive`);
    await extractEntry(zip, e.name, out, e);
  }
}

/** Run `fn` after the jobs already queued for `key`; resolves to its result. */
function queue(key, fn) {
  const prev = inflight.get(key) || Promise.resolve();
  const job = prev.catch(() => {}).then(fn);
  inflight.set(key, job);
  job.catch(() => {}).finally(() => { if (inflight.get(key) === job) inflight.delete(key); });
  return job;
}

/** Make sure `file` holds the download; resolves to its sha256 when known. */
async function ensure(url, dir, file, { sha256, size, inner, from, headers }) {
  const known = await fs.readFile(path.join(dir, SUM), 'utf8').then(s => s.trim(), () => null);
  // A copy of a different upstream file than the entry recorded: fetch it again (and verify).
  if (!(sha256 && known && known !== sha256.toLowerCase())) {
    if (await isRegular(file)) return known;
    // The same download cached under another name (add-by-link stores it before it knows the
    // final name): reuse it rather than downloading again. If anyone else holds this key (acquire
    // already counted us), they may still be about to push the old name, so hard-link the new
    // name next to it instead of moving it (release() drops whichever name is let go of first).
    const other = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
      .find(e => e.isFile() && !e.name.startsWith('.'));
    if (other) {
      const src = path.join(dir, other.name);
      if ((inUse.get(path.basename(dir)) || 0) > 1) await fs.link(src, file);
      else await fs.rename(src, file);
      return known;
    }
  }
  // Past here the directory gets wiped. With a copy still in it (a stale checksum) and someone
  // else holding it, that would delete their file before they push it: wait for them instead.
  if ((inUse.get(path.basename(dir)) || 0) > 1 &&
      (await fs.readdir(dir).catch(() => [])).some(f => !f.startsWith('.'))) {
    throw Object.assign(new Error('this download is in use by another session; try again when it ends'), { status: 409 });
  }
  if (from) return unpackLocal(from, dir, file, inner, sha256);
  return download(url, dir, file, { sha256, size, inner, headers });
}

/** Unpack `inner` from an archive already on disk (add-by-link) straight into the cache entry. */
async function unpackLocal(zip, dir, file, inner, sha256) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  try {
    const out = path.join(dir, XPART);
    await extractEntry(zip, inner, out);
    await fs.rename(out, file);
    if (sha256) await fs.writeFile(path.join(dir, SUM), sha256.toLowerCase());
    return sha256 || null;
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Drop the cached copy of a link (e.g. when its library entry is removed). */
export async function forget(url, inner, { tree } = {}) {
  const key = keyOf(url, tree ? TREE_TAG : inner);
  if (inUse.has(key) || inflight.has(key)) return;
  await fs.rm(path.join(config.cacheDir, key), { recursive: true, force: true });
}

// Replies worth asking again: rate limits (download sites answer a burst with 403/429) and
// passing server trouble. Each retry waits a little longer.
const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const ATTEMPTS = 4;
const LOOKUP_MS = 20_000;          // one APKPure version-list lookup (apkpure.js)
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

/** Two sizes in MB, with as many decimals as it takes to tell them apart. */
function sizes(a, b) {
  for (let d = 0; d <= 3; d++) {
    const x = (a / MB).toFixed(d), y = (b / MB).toFixed(d);
    if (x !== y) return [`${x} MB`, `${y} MB`];
  }
  return [`${a} bytes`, `${b} bytes`];
}

/**
 * The fresh link to the exact file a pinned APKPure link names. Asks again through rate limits
 * and passing trouble (each try has its own time limit; `bump` keeps the caller's stall timer
 * from firing meanwhile). Throws a clear error when APKPure can't be asked or no longer has it.
 */
async function lookup(url, bump) {
  for (let attempt = 1; ; attempt++) {
    let err;
    try {
      const link = await apkpure.resolve(url, { signal: AbortSignal.timeout(LOOKUP_MS) });
      if (link) return link;
      err = Object.assign(new Error(`APKPure no longer offers the exact build this game's link is pinned to (${urlName(url)}); the game needs a new link`), { status: 502, final: true });
    } catch (e) {
      err = e;
    }
    bump();
    const again = !err.final && (!err.status || RETRY_STATUS.has(err.status)) && attempt < ATTEMPTS;
    if (!again) {
      if (err.final) throw err;
      throw Object.assign(new Error(`could not ask APKPure for the exact build this game's link is pinned to (${err.message}); try again later`), { status: 502 });
    }
    console.log(`APKPure lookup for ${urlName(url)}: ${err.message}; asking again (${attempt}/${ATTEMPTS - 1})`);
    await sleep(2000 * attempt);
    bump();
  }
}

/** Download into `dir` (wiped first); resolves to the download's sha256. */
async function download(url, dir, file, { sha256, size, inner, tree, headers }) {
  const host = hostOf(url);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, PART);
  const ac = new AbortController();
  let idle;
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), IDLE_MS); };
  bump();
  try {
    const authed = Object.keys(headers || {}).some(k => k.toLowerCase() === 'authorization');
    // With a known checksum and size, a reply of another size is another file: download sites
    // sometimes ignore the version a link pins and send their newest build. Ask again rather
    // than download it only to fail the checksum.
    const expect = sha256 && Number(size) > 0 ? Number(size) : 0;
    // A pinned APKPure link ("#asset=<id>") is fetched through a fresh link to that exact file
    // (apkpure.js), never as it is: over IPv4 d.apkpure.com ignores the version the link asks for
    // and sends its newest default build (often one for a newer Android), which add-by-link would
    // then record as this game. So no lookup, no download.
    const src = authed || !apkpure.pinned(url) ? null : await lookup(url, bump);
    let res, total = 0;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(src || url, { signal: ac.signal, redirect: authed ? 'error' : 'follow',
        headers: { 'user-agent': 'Rose/1.0 (self-hosted game streaming)', ...(headers || {}) } });
      total = Number(res.headers.get('content-length')) || 0;
      const why = !res.ok ? (RETRY_STATUS.has(res.status) && !authed ? `HTTP ${res.status}` : '')
        : expect && total && total !== expect ? `a ${sizes(total, expect).join(' file instead of ')}` : '';
      if (!why || attempt >= ATTEMPTS) break;
      await res.body?.cancel().catch(() => {});
      console.log(`download of ${urlName(url)} from ${host}: got ${why}; asking again (${attempt}/${ATTEMPTS - 1})`);
      await sleep(2000 * attempt);
      bump();
    }
    const from = src ? hostOf(src) : host;   // a pinned link's file comes from APKPure's own download host
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} from ${from}`);
    if (expect && total && total !== expect) {
      await res.body.cancel().catch(() => {});
      throw new Error(`${from} sent a different file than the one this game was added with (${sizes(total, expect).join(' instead of ')}): it was updated there, or the site ignored the version the link asks for. Try again; if it keeps happening, re-add the game.`);
    }
    const cap = maxBytes();
    if (total > cap) throw tooBig(`the download from ${host} (${Math.round(total / MB)} MB)`);
    if (total) await checkSpace(total);
    console.log(`downloading ${urlName(url)}${total ? ` (${Math.round(total / MB)} MB)` : ''} from ${host}`);
    const hash = crypto.createHash('sha256');
    // Capped even without a Content-Length: a chunked reply that never ends would fill the disk
    // (CACHE_MB only applies after the download). More than announced means the server is lying.
    const m = meter(total || cap, `the download from ${host}`, chunk => { hash.update(chunk); bump(); });
    await pipeline(Readable.fromWeb(res.body), m, createWriteStream(tmp));
    // The body is in: stop the stall timer, or unpacking a multi-GB game (which can take over
    // IDLE_MS) would abort and mask a real error (413, 507, corrupt entry) as "stalled".
    clearTimeout(idle);
    const got = m.bytes;
    if (total && got !== total) throw new Error(`download from ${host} was cut off (${got} of ${total} bytes)`);
    const digest = hash.digest('hex');
    if (sha256 && digest !== sha256.toLowerCase()) {
      throw new Error(`the file from ${host} doesn't match its checksum (it changed upstream, or the download is corrupt)`);
    }
    if (tree) {
      const out = path.join(dir, XPART);
      await extractTree(tmp, out);
      await fs.rename(out, file);
      await fs.rm(tmp, { force: true });
    } else if (inner) {
      const out = path.join(dir, XPART);
      await extractEntry(tmp, inner, out);
      await fs.rename(out, file);
      await fs.rm(tmp, { force: true });
    } else {
      await fs.rename(tmp, file);
    }
    await fs.writeFile(path.join(dir, SUM), digest);
    console.log(`downloaded ${tree ? `${urlName(url)} (unpacked)` : path.basename(file)} (${Math.max(1, Math.round(got / MB))} MB) from ${host}`);
    return digest;
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    if (ac.signal.aborted) throw new Error(`the download from ${host} stalled; try again later`);
    if (e.cause?.code === 'ENOTFOUND' || e.cause?.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNRESET') {
      throw new Error(`could not reach ${host} (${e.cause.code})`);
    }
    throw e;
  } finally {
    clearTimeout(idle);
  }
}

export async function checkSpace(bytes) {
  const st = await fs.statfs(config.cacheDir).catch(() => null);
  if (!st) return;
  const free = st.bavail * st.bsize;
  if (free - bytes < 1024 * MB) {
    throw Object.assign(new Error(bytes
      ? `not enough disk space for this download (${Math.round(bytes / MB)} MB, ${Math.round(free / MB)} MB free)`
      : `the disk is almost full (${Math.round(free / MB)} MB free); stopped the download`), { status: 507 });
  }
}

const maxBytes = () => Math.max(1, config.maxDownloadMb) * MB;
const tooBig = what => Object.assign(new Error(`${what} is larger than the ${Math.round(maxBytes() / MB)} MB limit (MAX_DOWNLOAD_MB)`), { status: 413 });

/**
 * Pass-through that counts bytes (.bytes), fails once more than `limit` come through, and
 * re-checks free space every SPACE_EVERY bytes (the size may be unknown up front, or a lie).
 */
function meter(limit, what, onChunk) {
  let next = SPACE_EVERY;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      t.bytes += chunk.length;
      onChunk?.(chunk);
      if (t.bytes > limit) {
        return cb(limit < maxBytes()
          ? Object.assign(new Error(`${what} is larger than it claimed (${Math.round(limit / MB)} MB)`), { status: 413 })
          : tooBig(what));
      }
      if (t.bytes < next) return cb(null, chunk);
      next += SPACE_EVERY;
      checkSpace(0).then(() => cb(null, chunk), cb);
    },
  });
  t.bytes = 0;
  return t;
}

/** Entries of a zip: [{ name, size (declared, uncompressed), file (a regular file, not a dir/symlink) }]. */
export async function zipEntries(zip) {
  const { stdout } = await run('unzip', ['-Z', zip], { maxBuffer: 64 * MB });
  // zipinfo lines: "-rw-r--r--  3.0 unx  12345 tx defN 24-Nov-02 10:00 dir/name"
  const re = /^([-?a-zA-Z]{7,10})\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+ (.+)$/;
  return stdout.split('\n').map(l => l.match(re)).filter(Boolean)
    .map(([, mode, size, name]) => ({ name, size: Number(size), file: /^[-?]/.test(mode) && !name.endsWith('/') }));
}

/**
 * Unpack one archive member to `dest`. Streamed with `unzip -p` into a file Rose creates, so a
 * symlink or "../" entry can't put anything outside `dest`, and capped at the size the archive
 * declares (and MAX_DOWNLOAD_MB), so a zip bomb can't fill the disk.
 */
export async function extractEntry(zip, inner, dest, entry) {
  if (!safeInner(inner)) throw new Error(`bad archive path: ${inner}`);
  const e = entry || (await zipEntries(zip).catch(() => [])).find(x => x.name === inner);
  if (!e) throw new Error(`"${inner}" is not in the archive`);
  if (!e.file) throw new Error(`"${inner}" in the archive is not a regular file`);
  if (e.size > maxBytes()) throw tooBig(`"${inner}" (${Math.round(e.size / MB)} MB unpacked)`);
  await checkSpace(e.size);
  const child = spawn('unzip', ['-p', zip, unzipLiteral(inner)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', d => { err = (err + d).slice(-500); });
  const exited = new Promise((ok, fail) => { child.on('error', fail); child.on('close', ok); });
  exited.catch(() => {});
  const m = meter(e.size, `"${inner}"`);
  try {
    await pipeline(child.stdout, m, createWriteStream(dest));
  } catch (x) {
    child.kill();
    await fs.rm(dest, { force: true });
    throw x;
  }
  const code = await exited;
  if ((code !== 0 && code !== 1) || m.bytes !== e.size) {   // 1 = warnings only
    await fs.rm(dest, { force: true });
    throw new Error(`could not unpack "${inner}" (${err.trim().split('\n').pop() || `unzip exit ${code}`})`);
  }
}

// Evictions run one at a time; each pass trims the cache back under CACHE_MB.
let evicting = Promise.resolve();
function evict() {
  evicting = evicting.then(async () => {
    const cap = Math.max(0, config.cacheMb) * MB;
    const entries = [];
    for (const key of await fs.readdir(config.cacheDir).catch(() => [])) {
      const dir = path.join(config.cacheDir, key);
      let size = 0, used = 0;
      for (const f of await fs.readdir(dir).catch(() => [])) {
        const st = await fs.lstat(path.join(dir, f)).catch(() => null);
        if (st?.isFile()) { size += st.size; used = Math.max(used, st.mtimeMs); }
        else if (st?.isDirectory() && f === TREE) { size += await treeSize(path.join(dir, f)); used = Math.max(used, st.mtimeMs); }
      }
      entries.push({ key, dir, size, used });
    }
    let total = entries.reduce((n, e) => n + e.size, 0);
    for (const e of entries.sort((a, b) => a.used - b.used)) {
      if (total <= cap) break;
      if (inUse.has(e.key) || inflight.has(e.key)) continue;
      await fs.rm(e.dir, { recursive: true, force: true });
      total -= e.size;
    }
  }).catch(e => console.warn('cache cleanup failed:', e.message));
  return evicting;
}

async function treeSize(dir) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += await treeSize(p);
    else if (e.isFile()) n += (await fs.lstat(p).catch(() => ({ size: 0 }))).size;
  }
  return n;
}

/** Called at startup: drop downloads interrupted by a restart, then apply the size cap. */
export async function init() {
  await fs.mkdir(config.cacheDir, { recursive: true });
  for (const key of await fs.readdir(config.cacheDir).catch(() => [])) {
    const dir = path.join(config.cacheDir, key);
    if ((await fs.readdir(dir).catch(() => [])).some(f => f.endsWith('.part'))) await fs.rm(dir, { recursive: true, force: true });
  }
  await evict();
}
