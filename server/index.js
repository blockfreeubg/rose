import express from 'express';
import multer from 'multer';
import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { SessionManager } from './sessions.js';
import crypto from 'node:crypto';
import * as library from './library.js';
import * as meta from './meta.js';
import { coverDir } from './library.js';
import * as bundle from './bundle.js';
import * as chunked from './chunked.js';
import * as emulators from './emulators.js';
import * as fetcher from './fetcher.js';
import * as keymaps from './keymaps.js';
import { NAV, sanitizeInput } from './tunnel.js';
import { NodeRegistry } from './nodes.js';
import { requireAccount, publicAuthConfig, wsUser, handleProtocols, authOn } from './auth.js';
import * as assets from './assets.js';
import * as plus from './plus.js';
import { NodeAgent, preflight } from './node-agent.js';

// Node mode (ROSE_HUB_URL + ROSE_NODE_TOKEN): this Rose runs sessions on this machine for a hub and
// serves nothing public. It listens on 127.0.0.1 only, and its API is reached only by its own agent
// (node-agent.js), which replays what the hub relays: with a random per-boot token nobody else knows.
// There is no upload password on a node (the library belongs to the hub).
const NODE = config.nodeMode;
if (NODE) {
  config.accessToken = crypto.randomBytes(24).toString('hex');
  config.uploadPassword = crypto.randomBytes(24).toString('hex');
}

const manager = new SessionManager();
const app = express();
app.use(express.json({ limit: '64kb' }));
if (NODE) {
  // Only what the hub can ask a node for; no library, reviews, keymaps, covers, images or pages.
  const allowed = [
    ['POST', /^\/api\/sessions$/],
    ['GET', /^\/api\/sessions\/[0-9a-f]{10}$/], ['DELETE', /^\/api\/sessions\/[0-9a-f]{10}$/],
    ['POST', /^\/api\/sessions\/[0-9a-f]{10}\/(play|launch|push|apk|file)$/],
    ['GET', /^\/api\/stats$/],
  ];
  app.use((req, res, next) => {
    if (!allowed.some(([m, re]) => m === req.method && re.test(req.path))) return res.status(404).json({ error: 'not found' });
    // Players' own apps and files run on the host's machine: only if its operator allows it.
    if (/\/(apk|file)$/.test(req.path) && !config.nodeAllowUploads) return res.status(403).json({ error: 'This host does not take uploads.' });
    next();
  });
}
// Accounts (auth.js, ACCOUNTSETUP.md): with ROSE_REQUIRE_ACCOUNT=1 every /api call needs a signed-in
// Supabase user, except the config the sign-in screen loads. Off: req.user = null, nothing changes.
// (A node never checks accounts: the hub did, and only the hub reaches it.)
app.get('/api/auth-config', (req, res) => res.set('Cache-Control', 'no-store').json(publicAuthConfig()));
if (!NODE) app.use('/api', requireAccount);

const upload = multer({ dest: path.join(os.tmpdir(), 'rose-uploads'), limits: { fileSize: 8 * 1024 ** 3 } });
const safeName = n => path.basename(String(n)).replace(/[^\w.\- ]/g, '_');
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});

// Long operations (boot, install, push) send their 200 status at once, then a space every second
// until the JSON result (or {error}) arrives. Firefox drops any request that receives nothing for
// ~5s after the host's network changes, and Docker changes it each time a session container
// starts (a new veth), so a silent install of a big game failed with "NetworkError".
// The heartbeat also stops tunnels/proxies from timing out idle requests.
const long = fn => async (req, res) => {
  res.status(200).type('json').set('Cache-Control', 'no-store');
  res.flushHeaders();
  const beat = setInterval(() => res.write(' '), 1000);
  let body;
  try {
    body = await fn(req, res);
  } catch (e) {
    console.error(e);
    res.locals.error = e.message;
    body = { error: e.message, status: e.status || 500, ...(e.queue ? { queue: true } : {}), ...(e.needPlus ? { needPlus: true } : {}) };
  } finally {
    clearInterval(beat);
  }
  res.end(JSON.stringify(body));
};

function authorized(token) {
  return !config.accessToken || token === config.accessToken;
}

// A page on another site must not drive this server through a visitor's browser (CSRF): with no
// ACCESS_TOKEN that page could add links, or replace a game's APK. Browsers say where a request
// comes from (Sec-Fetch-Site, else Origin); requests from tools like curl carry neither.
// Behind a tunnel the Host header is the tunnel's host, so same-origin still matches.
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch { return true; }   // e.g. "null" from a sandboxed frame
  return host !== req.headers.host && host !== req.headers['x-forwarded-host'];
}

// Log every non-GET API call with its outcome (uploads, installs, sessions).
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const t0 = Date.now();
  res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.locals.error ? `error: ${res.locals.error}` : res.statusCode} (${Date.now() - t0}ms)`));
  next();
});
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (crossSite(req)) return res.status(403).json({ error: 'cross-site request refused' });
    // A custom header can't be sent cross-origin without a CORS preflight (which Rose never
    // answers), so requiring it blocks plain form/no-cors posts too. The app always sends it,
    // empty when there's no token.
    if (req.get('x-access-token') === undefined) return res.status(403).json({ error: 'send the x-access-token header (empty if no token is set)' });
  }
  if (authorized(req.get('x-access-token') || req.query.token)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.use('/api', chunked.router());

// ---- upload password: guards every change to the library (add, edit, remove, page info) ----
const sameSecret = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
// Slow down guessing: after 10 wrong passwords in 15 minutes from one client, refuse it for 10 minutes.
// Behind the cloudflared tunnel every visitor arrives from the tunnel container's IP, so there the
// client is the CF-Connecting-IP it reports (trusted ONLY from the tunnel container, never from
// anyone else, who could otherwise forge it to dodge the limit). Without this, one stranger could
// lock everyone using the tunnel, the owner included, out of the upload page.
const plainIp = a => String(a || '').replace(/^::ffff:/, '');
let tunnelIps = new Set(), tunnelCheckedAt = 0;
const refreshTunnel = () => {
  if (Date.now() - tunnelCheckedAt < 60_000) return;
  tunnelCheckedAt = Date.now();
  dns.lookup('rose-tunnel', { all: true }).then(r => { tunnelIps = new Set(r.map(x => plainIp(x.address))); }, () => { tunnelIps = new Set(); });
};
// cloudflared on the host (scripts/rose-tunnel.service) comes in on TUNNEL_PORT, which compose
// publishes on 127.0.0.1 only, so its connections arrive from this container's default gateway (the
// host's side of the Docker network). Session containers share that network but have addresses of
// their own: they can't pass for it, so they can't forge CF-Connecting-IP either.
let gatewayIp = '';
if (config.tunnelPort) {
  fs.readFile('/proc/net/route', 'utf8').then(t => {
    const row = t.split('\n').map(l => l.trim().split(/\s+/)).find(c => c[1] === '00000000' && /^[0-9A-F]{8}$/i.test(c[2] || '') && c[2] !== '00000000');
    gatewayIp = row ? [6, 4, 2, 0].map(i => parseInt(row[2].slice(i, i + 2), 16)).join('.') : '';   // little-endian hex
    if (!gatewayIp) console.warn('TUNNEL_PORT is set, but no default gateway was found: CF-Connecting-IP is not trusted on it');
  }, () => console.warn('TUNNEL_PORT is set, but /proc/net/route is unreadable: CF-Connecting-IP is not trusted on it'));
}
const fromHostTunnel = (req, peer) => !!config.tunnelPort && req.socket.localPort === config.tunnelPort && !!gatewayIp && peer === gatewayIp;
function clientKey(req) {
  refreshTunnel();
  const peer = plainIp(req.socket.remoteAddress);
  const cf = req.headers['cf-connecting-ip'];   // also raw upgrade requests (no req.get)
  return cf && (tunnelIps.has(peer) || fromHostTunnel(req, peer)) ? `cf:${String(cf).slice(0, 64)}` : peer;
}
const misses = new Map();   // client -> { n, last, until }
const MISS_WINDOW = 15 * 60_000, LOCK_FOR = 10 * 60_000, MAX_MISSES = 10;
function uploadAllowed(req) {
  const now = Date.now(), key = clientKey(req);
  let m = misses.get(key);
  if (m && m.until > now) return 'locked';
  if (sameSecret(req.get('x-upload-password') ?? '', config.uploadPassword)) { misses.delete(key); return 'ok'; }
  if (!m || m.until || now - m.last > MISS_WINDOW) m = { n: 0 };   // old misses and finished lockouts start over
  m.n++; m.last = now; m.until = m.n >= MAX_MISSES ? now + LOCK_FOR : 0;
  misses.delete(key); misses.set(key, m);   // re-insert: the Map stays ordered oldest-first
  for (const k of misses.keys()) { if (misses.size <= 10_000) break; misses.delete(k); }   // evict the oldest, never reset everyone
  return m.until ? 'locked' : 'wrong';
}
function requireUpload(req, res, next) {
  const r = uploadAllowed(req);
  if (r === 'ok') return next();
  res.locals.error = 'upload password';
  res.status(403).json({ error: r === 'locked' ? 'Too many wrong passwords. Try again in 10 minutes.' : 'Wrong upload password', needUploadPassword: true });
}
app.post('/api/upload-login', requireUpload, (req, res) => res.json({ ok: true }));

// ---- Rose+ (plus.js): a free test subscription, turned on and off on the Profile page ----
const meOf = async req => ({
  accounts: authOn(),
  user: req.user ? { id: req.user.id, email: req.user.email } : null,
  plus: await plus.get(req.user),
});
app.get('/api/me', wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await meOf(req))));
app.put('/api/me/plus', wrap(async (req, res) => {
  if (!plus.enabled()) throw bad('Sign-in is off on this server, so there are no accounts or Rose+.', 409);
  if (!req.user) return res.status(401).json({ error: 'Sign in first.', needAccount: true });   // requireAccount already saw to it
  if (typeof req.body?.active !== 'boolean') throw bad('send {"active": true} or {"active": false}');
  await plus.set(req.user, req.body.active);
  manager.queuePriority(req.user.id, req.body.active);   // tickets already waiting move with it
  res.set('Cache-Control', 'no-store').json(await meOf(req));
}));
// Everything that can start a Switch game (console entries, the emulator's own tile) checks here
// first: creating a session for one (also when claiming a place in line), /play and /launch, local
// or on a node. Before anything boots, downloads or installs, so this is a real 403 (long() would
// already have answered 200). The server decides from the signed-in account, never from the page.
function plusGate(req, res, next) {
  if (!plus.enabled()) return next();
  (async () => {
    if (await plus.isPlus(req.user)) return true;
    const raw = req.body?.game;   // read the way the routes below read it
    const g = raw ? await library.get(String(raw)) : null;
    // A body can also name an installed app by its package (/launch): an emulator counts too. On
    // every gated route, not by req.path: Express also routes /launch/ and /LAUNCH to /launch.
    return !plus.needsPlus(g) && !plus.emulatorPkg(String(req.body?.pkg || ''));
  })().then(ok => {
    if (ok) return next();
    res.locals.error = 'needs Rose+';
    res.status(403).json({ error: plus.NEED_PLUS, needPlus: true });
  }, e => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });
}
// A player's own APK (Install an app) that is an emulator: Switch content too. Read from the file
// itself, before it is installed or sent on to a node; members skip the check. Every APK in a
// bundle counts, since the install picks its own few of them (bundle.selectApks).
const plusRefusesApk = async (user, file) => plus.enabled() && !(await plus.isPlus(user)) && (await bundle.packagesOf(file)).some(plus.emulatorPkg);
// An app that turns out to be an emulator once its package is known (the library said nothing, so
// plusGate let it through). A node never checks membership: the hub sends noEmulator for a non-member.
const plusRefusesPkg = async (req, pkg) => plus.emulatorPkg(pkg) && (plus.enabled() ? !(await plus.isPlus(req.user)) : NODE && req.body?.noEmulator === true);
// "Restart game" on the stream ({t:'relaunch'}): a Switch game that kept running after its player
// cancelled Rose+ may run on, but starting it again is a new launch. `plusGame`: what it would relaunch is one.
const plusMayRelaunch = async (user, plusGame) => !plus.enabled() || !plusGame || plus.isPlus(user);

// ---- Rose nodes: other people's machines running sessions for this hub (nodes.js) ----
// Node tokens work only on /node/tunnel, /node-api/* and /node/bundle.tgz: never as x-access-token
// or upload password. /api/nodes (join tokens, kill switches, placement) needs the upload password.
const nodes = config.nodeMode ? null : new NodeRegistry({ manager, libraryVersion: () => libraryVersion(), clientKey });
if (nodes) {
  manager.remote = nodes;
  app.use('/api/nodes', nodes.adminRouter(requireUpload));
  app.use('/node-api', nodes.nodeApi());
  app.use('/node', nodes.installRouter());
}


function sessionOr404(req) {
  const s = manager.get(req.params.id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  return s;
}

// ---- game library ----
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
// Copies under a hidden temp name, then hard-links it into place: list() never sees a half-copied
// file, and an existing game is never replaced (link fails if the name is taken).
const moveUpload = async (f, dest) => {
  const tmp = path.join(path.dirname(dest), `.${crypto.randomBytes(6).toString('hex')}.part`);
  try {
    await fs.copyFile(f.path, tmp);
    await fs.link(tmp, dest).catch(e => { throw e.code === 'EEXIST' ? taken(dest) : e; });
  } finally {
    await fs.rm(tmp, { force: true });
  }
  await fs.rm(f.path, { force: true });
};
const taken = dest => bad(`${path.basename(dest)} is already on the server: pick it from the files on the server, or remove its game first`, 409);
const refuseExisting = dest => fs.access(dest).then(() => { throw taken(dest); }, () => {});
const cleanupUploads = req => Promise.all(Object.values(req.files || {}).flat().map(f => fs.rm(f.path, { force: true })));

let warming = false;
app.get('/api/library', wrap(async (req, res) => {
  const [games, ratings, infos] = await Promise.all([library.list(), meta.summary(), meta.cached()]);
  const plusOn = plus.enabled();
  for (const g of games) {
    if (ratings[g.id]) g.reviews = ratings[g.id];
    // Rose+ content: a property of the game, the same for everyone (who is a member is /api/me).
    if (plusOn && plus.needsPlus(g)) g.plus = true;
    const i = infos[g.id];
    // No cover of its own: use the store icon (through the /img cache).
    if (i?.icon && !g.coverUrl) g.coverUrl = `/img?u=${encodeURIComponent(/googleusercontent\.com/.test(i.icon) ? `${i.icon}=s256` : i.icon)}`;
    if (i) Object.assign(g, { banner: i.screenshots?.[0] || null, genre: i.genre || null, developer: i.developer || null, blurb: i.description || null, hasTrailer: !!i.trailer });
  }
  if (!warming) { warming = true; meta.warm(games).catch(() => {}).finally(() => { warming = false; }); }
  // ~50 KB of JSON that compresses ~10x: gzip it for browsers that accept it.
  const body = JSON.stringify(games.sort((a, b) => a.title.localeCompare(b.title)));
  res.set('Vary', 'Accept-Encoding').type('json');
  if (/\bgzip\b/.test(req.get('accept-encoding') || '')) res.set('Content-Encoding', 'gzip').send(zlib.gzipSync(body));
  else res.send(body);
}));

// A number that changes whenever GET /api/library would: library.json or store info/reviews were
// saved, or a file appeared in apks/ or roms/ (re-read at most every 5 s). roms/ by folder mtime;
// apks/ by its game files' names, sizes and times, since the folder mtime also moves with the JSON
// stores kept beside them (plus.json changes with every Rose+ toggle).
let dirStamp = 0, dirStampAt = 0;
async function libraryVersion() {
  if (Date.now() - dirStampAt > 5000) {
    dirStampAt = Date.now();
    const dirs = Object.keys(emulators.SYSTEMS).map(id => path.join(config.romDir, id));
    const times = await Promise.all(dirs.map(d => fs.stat(d).then(st => st.mtimeMs, () => 0)));
    const apks = (await fs.readdir(config.apkDir).catch(() => [])).filter(n => bundle.PACKAGE_RE.test(n)).sort();
    const files = await Promise.all(apks.map(n => fs.stat(path.join(config.apkDir, n)).then(st => `${n}:${st.size}:${st.mtimeMs}`, () => n)));
    const sig = crypto.createHash('sha256').update(files.join('\n')).digest().readUInt32BE(0);
    dirStamp = Math.round(Math.max(0, ...times)) + sig;
  }
  return dirStamp + library.version + meta.version;
}

// Add a game: multipart with title, category and one source:
//   apk     - an uploaded game file: APK/bundle (kept in apks/) or console game (kept in roms/<system>/)
//   url     - a download link: nothing is stored here; it's downloaded when played
//   apkName - a file already in apks/
// plus an optional `cover` image and `file` (name in files/).
app.post('/api/library', requireUpload, upload.fields([{ name: 'apk', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), chunked.adopt('apk'), long(async req => {
  let unreserve = () => {};
  try {
    const up = req.files?.apk?.[0];
    const url = String(req.body.url || '').trim();
    let fields, meta = {};
    if (up) {
      // Metadata is read from the upload before it lands in apks/ or roms/, and list() is kept
      // from auto-importing it meanwhile (it would unpack a big bundle a second time).
      const name = safeName(up.originalname);
      const sys = emulators.systemForFile(name);
      if (sys) {
        const rom = `${sys.id}/${name}`;
        const dest = path.join(config.romDir, rom);
        await refuseExisting(dest);
        unreserve = library.reserve(rom);
        meta = await library.fileMeta(up.path, { kind: 'rom', ext: path.extname(name).toLowerCase() });
        await fs.mkdir(path.join(config.romDir, sys.id), { recursive: true });
        await moveUpload(up, dest);
        fields = { system: sys.id, rom };
      } else {
        if (!bundle.PACKAGE_RE.test(name)) throw bad('the game file must be an .apk, .apkm, .apks or .xapk, or a console game (.nro, .nsp, .xci)');
        const dest = path.join(config.apkDir, name);
        await refuseExisting(dest);
        unreserve = library.reserve(name);
        if (bundle.isBundle(name)) meta = await library.fileMeta(up.path, { kind: 'bundle' });
        await moveUpload(up, dest);
        fields = { apk: name };
      }
    } else if (url) {
      if (!fetcher.isUrl(url)) throw bad('the download link must start with http:// or https://');
      ({ fields, meta } = await inspectLink(url));
    } else if (req.body.apkName) {
      const apk = safeName(req.body.apkName);
      await fs.access(path.join(config.apkDir, apk)).catch(() => { throw bad('APK not found', 404); });
      fields = { apk };
      if (bundle.isBundle(apk)) meta = await library.fileMeta(path.join(config.apkDir, apk), { kind: 'bundle' });
    } else {
      throw bad('upload a game file, paste a download link, or pick a file already on the server');
    }

    let cover;
    const coverUp = req.files?.cover?.[0];
    if (coverUp) {
      const ext = (path.extname(coverUp.originalname) || '.png').toLowerCase();
      if (!/^\.(png|jpe?g|webp|gif)$/.test(ext)) throw bad('cover must be png/jpg/webp/gif');
      cover = crypto.randomBytes(6).toString('hex') + ext;
      await fs.mkdir(coverDir(), { recursive: true });
      await moveUpload(coverUp, path.join(coverDir(), cover));
    } else if (meta.icon) {
      cover = await library.saveCover(meta.icon, meta.iconExt);
    }
    const file = req.body.file ? safeName(req.body.file) : undefined;
    return await library.add({
      ...fields, title: req.body.title || meta.title, category: req.body.category, file, cover,
      pkg: meta.pkg, credit: meta.credit,
    });
  } finally {
    unreserve();
    await cleanupUploads(req);
  }
}));

/**
 * Download a link once to see what it is (links often hide the file type) and to read its name
 * and icon. The copy is left in the cache under the name play asks for (for a zip: the game
 * unpacked from it), and its sha256 is recorded so a later download can't be swapped.
 */
async function inspectLink(url) {
  const dl = await fetcher.acquire(url);
  let zipped = false;
  try {
    const kind = await library.sniff(dl.path);
    if (!kind) throw bad("that link doesn't lead to an Android app (.apk/.apkm/.apks/.xapk) or a console game (.nro/.nsp/.xci, or a .zip with one)");
    const withExt = (name, ext) => (name.toLowerCase().endsWith(ext) ? name : `${name.replace(/\.[a-z0-9]{1,5}$/i, '')}${ext}`);
    const sha256 = dl.sha256;
    let fields, meta;
    if (kind.kind !== 'rom') {
      meta = kind.kind === 'bundle' ? await library.fileMeta(dl.path, kind) : {};
      fields = { apkUrl: url, apkName: withExt(fetcher.urlName(url), kind.ext), size: (await fs.stat(dl.path)).size, sha256 };
    } else if (!kind.inner) {
      meta = await library.fileMeta(dl.path, kind);
      fields = { system: kind.system, romUrl: url, romName: withExt(fetcher.urlName(url), kind.ext), size: (await fs.stat(dl.path)).size, sha256 };
    } else {
      // A zip release: remember which file inside it is the game, and unpack it into the cache
      // entry play will use (the archive itself isn't needed after that).
      fields = { system: kind.system, romUrl: url, romPath: kind.inner, sha256 };
      const rom = await fetcher.acquire(url, { inner: kind.inner, name: library.fileName(fields), sha256, from: dl.path });
      try {
        meta = await library.fileMeta(rom.path, kind);
        fields.size = (await fs.stat(rom.path)).size;
      } finally {
        await rom.release();
      }
      zipped = true;
    }
    if (!zipped) {
      // Same cache entry, stored under the name play asks for (a link like /dl?id=5 is played as dl.nro).
      // Let go of the inspect name first: the last name released of a linked pair is the one kept.
      const kept = await fetcher.acquire(url, { name: library.fileName(fields), sha256 });
      await dl.release();
      await kept.release();
    }
    return { fields, meta };
  } finally {
    await dl.release();
    if (zipped) await fetcher.forget(url);
  }
}

app.patch('/api/library/:id', requireUpload, wrap(async (req, res) => {
  const { title, category } = req.body;
  // cover: the name of an image already in apks/covers/ (a plain file name, nothing else).
  let cover;
  if (req.body.cover !== undefined) {
    cover = String(req.body.cover);
    if (cover !== path.basename(cover) || cover.startsWith('.') || !/\.(png|jpe?g|webp|gif)$/i.test(cover)) throw bad('cover must be an image file name in covers/');
    await fs.access(path.join(coverDir(), cover)).catch(() => { throw bad('no such cover image on the server', 404); });
  }
  // memoryMb / cpus: this game gets a bigger session (sessions.js ensureResources); 0 or null = normal.
  const sizes = {};
  for (const [k, max] of [['memoryMb', 32768], ['cpus', os.cpus().length]]) {
    if (req.body[k] === undefined) continue;
    const v = req.body[k] === null || req.body[k] === '' ? 0 : Number(req.body[k]);
    if (!Number.isInteger(v) || v < 0 || v > max) throw bad(`${k} must be a whole number from 0 to ${max}`);
    sizes[k] = v;
  }
  // translator: which ARM translator this game's sessions use ('houdini' | 'ndk'; null or '' = the default).
  if (req.body.translator !== undefined) {
    const t = req.body.translator ?? '';
    if (t !== '' && !Object.hasOwn(config.translatorImages, t)) throw bad(`translator must be one of: ${Object.keys(config.translatorImages).join(', ')} (or empty)`);
    sizes.translator = t;
  }
  const g = await library.update(req.params.id, { title, category, cover, ...sizes });
  if (!g) throw bad('game not found', 404);
  res.json(g);
}));

// Remove a game. Deletes its file on this server too unless another entry still uses it
// (otherwise the orphaned file would reappear as an auto entry); download-link games just
// drop their cached copy.
app.delete('/api/library/:id', requireUpload, wrap(async (req, res) => {
  const g = await library.get(req.params.id);
  if (!g) throw bad('game not found', 404);
  await library.remove(g.id);
  await meta.forget(g.id);
  if (g.apk && !(await library.inUse('apk', g.apk))) await fs.rm(path.join(config.apkDir, g.apk), { force: true });
  if (g.rom && !(await library.inUse('rom', g.rom))) await fs.rm(path.join(config.romDir, g.rom), { force: true });
  if (g.apkUrl) await fetcher.forget(g.apkUrl);
  if (g.romUrl) { await fetcher.forget(g.romUrl, g.romPath); await fetcher.forget(g.romUrl); await fetcher.forget(g.romUrl, null, { tree: true }); }
  res.json({ ok: true });
}));

app.use('/covers', express.static(coverDir(), { maxAge: '7d' }));

// Store screenshots/icons/trailer thumbnails, fetched by Rose and cached on disk: browsers with
// tracker blocking (Brave, Firefox strict) block Google's image CDN when hotlinked, and players'
// browsers then never talk to Google at all. Only these hosts are proxied.
const IMG_HOSTS = new Set(['play-lh.googleusercontent.com', 'i.ytimg.com', 'raw.githubusercontent.com', 'user-images.githubusercontent.com', 'opengraph.githubassets.com']);
const imgDir = () => path.join(config.apkDir, 'imgcache');
app.get('/img', wrap(async (req, res) => {
  let u;
  try { u = new URL(String(req.query.u)); } catch { throw bad('bad image link'); }
  if (u.protocol !== 'https:' || !IMG_HOSTS.has(u.host)) throw bad('image host not allowed', 403);
  const file = path.join(imgDir(), crypto.createHash('sha1').update(u.href).digest('hex'));
  res.set('Cache-Control', 'public, max-age=604800');
  const hit = await fs.readFile(file).catch(() => null);
  const type = await fs.readFile(file + '.type', 'utf8').catch(() => 'image/jpeg');
  if (hit) return res.type(type).send(hit);
  const r = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.startsWith('image/')) throw bad('image not available', 502);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw bad('image too large', 502);
  await fs.mkdir(imgDir(), { recursive: true });
  await fs.writeFile(file + '.type', ct.split(';')[0]);
  await fs.writeFile(file, buf);
  res.type(ct.split(';')[0]).send(buf);
}));

// ---- game pages: store info + reviews ----
const gameOr404 = async id => { const g = await library.get(id); if (!g) throw bad('game not found', 404); return g; };
const isAdmin = req => !!config.accessToken && req.get('x-access-token') === config.accessToken;
app.get('/api/library/:id/page', wrap(async (req, res) => {
  const g = await gameOr404(req.params.id);
  const [info, reviews] = await Promise.all([meta.info(g), meta.list(g.id)]);
  const { manual = {}, failed, fetchedAt, ...found } = info;
  res.json({ info: { ...found, ...manual }, reviews, admin: isAdmin(req) });
}));
app.patch('/api/library/:id/meta', requireUpload, wrap(async (req, res) => {
  const g = await gameOr404(req.params.id);
  if (req.body?.refetch) await meta.refetch(g);
  res.json(await meta.setManual(g.id, req.body || {}));
}));
app.post('/api/library/:id/reviews', wrap(async (req, res) => {
  const g = await gameOr404(req.params.id);
  res.json(await meta.add(g.id, req.body || {}, req.user ? `user:${req.user.id}` : clientKey(req)));   // tunnel visitors share one IP
}));
app.patch('/api/library/:id/reviews/:rid', wrap(async (req, res) => {
  res.json(await meta.edit(req.params.id, req.params.rid, req.get('x-review-key'), req.body || {}));
}));
app.delete('/api/library/:id/reviews/:rid', wrap(async (req, res) => {
  await meta.remove(req.params.id, req.params.rid, req.get('x-review-key'), isAdmin(req));
  res.json({ ok: true });
}));


// ---- sessions ----
// Keyboard/mouse -> touch layouts saved for everyone (shipped defaults live in public/keymap.js).
app.get('/api/keymaps/:id', wrap(async (req, res) => res.set('Cache-Control', 'no-store').json((await keymaps.get(req.params.id)) || {})));
app.put('/api/keymaps/:id', requireUpload, wrap(async (req, res) => res.json((await keymaps.put(req.params.id, req.body)) || {})));

app.get('/api/stats', wrap(async (req, res) => res.json({ ...manager.stats(), libraryVersion: await libraryVersion() })));

// { ticket?, game? }: `game` (the library id about to be played) lets the hub pick a host that can
// run it. x-rose-place: local | node:<id> forces where it goes, honoured only with the upload password
// (the owner's test hook); from anyone else it is ignored.
app.post('/api/sessions', plusGate, long(async req => {
  const ticket = String(req.body?.ticket || '') || undefined;
  const game = typeof req.body?.game === 'string' && req.body.game ? req.body.game.slice(0, 64) : undefined;
  const asked = String(req.get('x-rose-place') || '');
  const place = nodes && /^(local|node:[0-9a-f]{8})$/.test(asked) && req.get('x-upload-password') !== undefined && uploadAllowed(req) === 'ok' ? asked : undefined;
  // A node never keeps a waiting line: full = say so at once, and the hub tries its next host.
  if (NODE && !manager.localHasSlot()) throw Object.assign(new Error('This host is full.'), { status: 503, queue: true });
  const image = NODE || !game ? undefined : imageFor(await library.get(game).catch(() => null));
  const s = await manager.create(NODE ? {} : { ticket, game, place, image });
  if (req.user) s.owner = req.user.id;   // only this account may use it (ownerOnly below)
  return s.info();
}));
// With accounts on, a session belongs to whoever started it: nobody else can view or drive it.
const ownerOf = id => (manager.get(id) || manager.remote?.get(id))?.owner;
const ownerOnly = (req, res, next) => {
  const owner = ownerOf(req.params.id);
  if (req.user && owner && owner !== req.user.id) return res.status(403).json({ error: 'That session belongs to another account.' });
  next();
};
app.use('/api/sessions/:id', ownerOnly);
// Rose+: before the node relay and the local handlers of both (plusGate above).
app.post(['/api/sessions/:id/play', '/api/sessions/:id/launch'], plusGate);
// Waiting line (see SessionManager.queueJoin). Rose+ members' tickets go ahead of the rest.
const TICKET = /^[0-9a-f]{24}$/;
app.post('/api/queue', wrap(async (req, res) => {
  const ticket = manager.queueJoin({ priority: await plus.isPlus(req.user), owner: req.user?.id || null });
  res.set('Cache-Control', 'no-store').json(ticket);
}));
app.get('/api/queue/:ticket', wrap(async (req, res) => {
  if (!TICKET.test(req.params.ticket)) return res.status(400).json({ error: 'bad ticket' });
  res.set('Cache-Control', 'no-store').json(manager.queueStatus(req.params.ticket));
}));
app.delete('/api/queue/:ticket', wrap(async (req, res) => { manager.queueLeave(req.params.ticket); res.json({ ok: true }); }));

// ---- sessions on a node: relayed over its tunnel. Each route hands local sessions on with
// next('route'). Only whitelisted body fields go to the node: never browser headers, cookies,
// the query token or the client's address.
const remoteOnly = (req, res, next) => (manager.isRemote(req.params.id) ? next() : next('route'));
const remoteOf = req => {
  const rs = manager.remote?.get(req.params.id);
  if (!rs) throw bad('session not found', 404);
  return rs;
};
const shortStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// Rose+ on a node: it can't tell who is a member, so for a non-member the hub tells it to refuse an
// app that turns out to be an emulator (plusRefusesPkg). Only the hub builds this body.
const noEmulator = async req => (plus.enabled() && !(await plus.isPlus(req.user)) ? { noEmulator: true } : {});
// rs.plusGame: what the node session last launched is Switch content, for "Restart game" there
// (attachViewer asks plusMayRelaunch). Raised before the call too: the node may start it even if
// its answer never arrives.
app.get('/api/sessions/:id', remoteOnly, wrap(async (req, res) => res.json(remoteOf(req).info())));
app.post('/api/sessions/:id/play', remoteOnly, long(async req => {
  const rs = remoteOf(req);
  const g = await library.get(String(req.body?.game));
  if (!g || g.missing) throw bad('game not found', 404);
  const c = nodes.conns.get(rs.nodeId);
  if (c && !nodes.gameAllowed(c, g)) throw bad('This game can only run on the main server.', 409);
  const launch = req.body?.launch !== false;
  if (launch) rs.plusGame ||= plus.needsPlus(g);
  const r = await nodes.callSession(rs, 'play', { game: g.id, launch, ...(await noEmulator(req)) });
  if (launch && !r.error) rs.plusGame = plus.needsPlus(g) || plus.emulatorPkg(r.pkg);
  return r;
}));
app.post('/api/sessions/:id/launch', remoteOnly, long(async req => {
  const rs = remoteOf(req);
  const g = req.body?.game ? await library.get(String(req.body.game)) : null;
  const c = nodes.conns.get(rs.nodeId);
  if (g && c && !nodes.gameAllowed(c, g)) throw bad('This game can only run on the main server.', 409);
  const pkg = shortStr(req.body?.pkg, 200), needs = plus.needsPlus(g) || plus.emulatorPkg(pkg);
  rs.plusGame ||= needs;
  const r = await nodes.callSession(rs, 'launch', { ...(g ? { game: g.id } : {}), ...(pkg ? { pkg } : {}), ...(await noEmulator(req)) });
  if (!r.error) rs.plusGame = needs;
  return r;
}));
app.post('/api/sessions/:id/push', remoteOnly, long(async req => {
  const rs = remoteOf(req);
  const name = safeName(req.body?.file);
  await fs.access(path.join(config.fileDir, name)).catch(() => { throw bad('file not found', 404); });
  nodes.grant(rs.nodeId, name);   // lets the node fetch just this file from /node-api/files for a while
  return nodes.callSession(rs, 'push', { file: name });
}));
// Uploads into a node session: the hub receives the file (multer or chunked) and streams it on.
const remoteUpload = (field, op) => [remoteOnly, (req, res, next) => {
  const c = nodes.conns.get(nodes.get(req.params.id)?.nodeId);
  if (c && !c.caps.uploads) return res.status(403).json({ error: 'This host does not take uploads.' });
  next();
}, upload.single(field), chunked.adopt(field), long(async req => {
  const rs = remoteOf(req);
  const f = req.file;
  try {
    if (!f) throw bad('no file');
    const name = safeName(f.originalname);
    if (op === 'apk' && !bundle.PACKAGE_RE.test(path.extname(name).toLowerCase())) throw bad('must be .apk, .apkm, .apks or .xapk');
    if (op === 'apk' && await plusRefusesApk(req.user, f.path)) throw plus.needPlusError();   // the node never checks
    const size = f.size ?? (await fs.stat(f.path)).size;
    const r = await nodes.callUpload(rs, op, { path: f.path, size }, name);
    if (op === 'apk' && r.packages?.[0]) rs.plusGame = plus.emulatorPkg(r.packages[0]);   // it became the game there
    return r;
  } finally {
    if (f) await fs.rm(f.path, { force: true });
  }
})];
app.post('/api/sessions/:id/apk', ...remoteUpload('apk', 'apk'));
app.post('/api/sessions/:id/file', ...remoteUpload('file', 'file'));

app.get('/api/sessions/:id', wrap(async (req, res) => res.json(sessionOr404(req).info())));

app.delete('/api/sessions/:id', wrap(async (req, res) => {
  await manager.end(req.params.id);
  res.json({ ok: true });
}));

// Play a library game in this session: install (unless already present; download-link games
// are fetched first), push its companion file if any, then launch. The package name is cached
// on first install. Console games go through their emulator instead (playConsoleGame).
app.post('/api/sessions/:id/play', long(async req => {
  const s = sessionOr404(req);
  const g = await library.get(String(req.body.game));
  if (!g || g.missing) throw bad('game not found', 404);
  if (g.system) {
    const r = await playConsoleGame(s, g);
    if (req.body.launch !== false) await startGame(s, g);   // the client launches it with /launch instead
    return r;
  }
  let pkg = g.pkg;
  if (await plusRefusesPkg(req, pkg)) throw plus.needPlusError();   // a node's own copy may know more than the hub's
  if (emulators.byPackage(pkg)) await s.ensureResources(emulators.byPackage(pkg).resources());
  // A game whose entry asks for a bigger session (memoryMb / cpus): grown before it installs, with
  // the same check against the host's free memory as for Switch games.
  const big = bigGame(g);
  if (big) await s.ensureResources(big);
  const installed = pkg && (await s.adb.listThirdPartyPackages()).has(pkg);
  if (!installed) {
    const apk = await library.acquireApk(g);
    let pkgs, own;
    try {
      own = await bundle.packageOf(apk.path);
      // Rose+: an entry that turns out to be an emulator only once downloaded (nothing about it said
      // so, plusGate let it through) is remembered as one, and not installed for a non-member.
      if (await plusRefusesPkg(req, own)) {
        if (own !== g.pkg) await library.update(g.id, { pkg: own });
        throw plus.needPlusError();
      }
      pkgs = await s.installApk(apk.path);
    } finally { await apk.release(); }
    // Only a package name read from the game's own file is saved to the (shared) library entry.
    // The before/after install diff can also contain apps a player installed into this session
    // at the same moment, so it is used just to launch this once, never saved.
    if (own) { pkg = own; if (pkg !== g.pkg) await library.update(g.id, { pkg }); }
    else pkg = pkgs.length === 1 ? pkgs[0] : pkg || pkgs[0];
  }
  // An emulator opened from its own tile: same setup as when it runs a game.
  const sys = emulators.byPackage(pkg);
  if (sys) {
    await s.ensureResources(sys.resources());
    if (!s.prepared.has(sys.id)) { await sys.prepare(s.adb); s.prepared.add(sys.id); }
  }
  if (g.file) await pushCompanion(s, g.file);
  if (!pkg) throw bad('installed, but could not tell which app in it is the game, so it could not be started');
  if (req.body.launch !== false) await startGame(s, null, pkg);
  s.game = g.title;
  s.system = sys ? sys.id : null;   // gamepad-only input rules follow what is playing (sessions.js)
  if (!sys && !big) s.releaseGrant();   // nothing big now: its unused memory grant stops blocking others
  return { pkg, title: g.title };
}));

/**
 * The Android image a library entry's ARM translator needs (translator: 'houdini' | 'ndk', with
 * HOUDINI_IMAGE / NDK_IMAGE set), or undefined for REDROID_IMAGE (and its warm sessions).
 */
function imageFor(g) {
  const image = g?.translator ? config.translatorImages[g.translator] : '';
  return image && image !== config.image ? image : undefined;
}

/** What a library entry asks for beyond a normal session ({ memoryMb, cpus }), or null. */
function bigGame(g) {
  const memoryMb = Number(g?.memoryMb) || 0, cpus = Number(g?.cpus) || 0;
  return memoryMb > config.memoryMb || cpus > config.cpus ? { memoryMb, cpus } : null;
}

/**
 * Start the game: the Android app `pkg`, or console game `g` through its emulator. It is pinned
 * (Home, Recents and Back at its root do nothing) and handed to the session's watchdog
 * (sessions.js setGame), which relaunches it the same way if it ever leaves the front. A session
 * runs only one game: the previous one is stopped, so it can't come back when this one closes.
 */
async function startGame(s, g, pkg) {
  const sys = g?.system ? emulators.systemFor(g.system) : null;
  if (sys) pkg = sys.pkg;
  const run = async () => {
    if (sys) {
      await sys.beforeLaunch?.(s.adb, romLocation(g));
      await s.adb.startIntent(sys.launchCommand(romLocation(g)), sys.pkg, sys.activity);
    } else {
      await s.adb.launch(pkg);
    }
    if (!(await s.adb.pin(pkg).catch(() => false))) console.warn(`session ${s.id}: could not pin ${pkg}`);
  };
  const prev = s.watch;
  s.clearGame();                              // its own stop/start is not the game leaving
  try {
    await run();
  } catch (e) {
    if (prev && !s.watch) { s.watch = prev; s.adb.pin(prev.pkg).catch(() => {}); }   // the old game is still in front
    throw e;
  }
  if (s.gamePkg && s.gamePkg !== pkg) await s.adb.shell(`am force-stop ${s.gamePkg}`).catch(() => {});
  s.gamePkg = pkg;
  s.setGame(pkg, run);
}

// Name a console game gets inside the emulator's storage (stable per library entry).
const romFile = g => `${String(g.id).replace(/[^\w-]/g, '')}${path.extname(g.fileName).toLowerCase()}`;
// Where it ends up in the emulator's user dir: its own copy in roms/, or (romTree) its place on the SD card.
const romLocation = g => (g.romTree ? `sdmc/${library.treeRomPath(g)}` : `roms/${romFile(g)}`);
// Names one version of a romTree archive (and where it goes), so a session that already has it skips the copy.
const treeTag = g => crypto.createHash('sha256').update(`${g.romUrl}\n${g.sha256 || ''}\n${library.treeDir(g)}`).digest('hex').slice(0, 16);

/** A file from files/ into the session's Downloads (on a node: fetched from the hub first). */
async function pushCompanion(s, name) {
  const f = await assets.file(name);
  try { await s.adb.push(f.path, `/sdcard/Download/${path.basename(name)}`); } finally { await f.release(); }
}

/** Console game: grow the session, install the emulator while the game downloads, copy it in. */
async function playConsoleGame(s, g) {
  const sys = emulators.systemFor(g.system);
  await s.ensureResources(sys.resources());
  // romTree: nothing to fetch when this session's SD card already holds that archive.
  const tree = !!g.romTree;
  const have = tree && await sys.hasTree(s.adb, treeTag(g));
  const romJob = Promise.resolve(have ? null : tree ? library.acquireRomTree(g) : library.acquireRom(g));
  romJob.catch(() => {});                       // awaited below; don't let it go unhandled meanwhile
  try {
    if (!(await s.adb.listThirdPartyPackages()).has(sys.pkg)) {
      const apk = await emulators.acquireEmulatorApk(sys);
      try { await s.installApk(apk.path); } finally { await apk.release(); }
    }
    if (!s.prepared.has(sys.id)) { await sys.prepare(s.adb); s.prepared.add(sys.id); }
  } catch (e) {
    romJob.then(r => r?.release(), () => {});
    throw e;
  }
  const rom = await romJob;
  if (rom) {
    try {
      if (tree) await sys.pushTree(s.adb, rom.path, treeTag(g), library.treeDir(g));
      else await sys.pushRom(s.adb, rom.path, romFile(g));
    } finally { await rom.release(); }
  }
  // Companion file (save, mod, update...), same as for Android games: the editor offers it for every entry.
  if (g.file) await pushCompanion(s, g.file);
  s.game = g.title;
  s.system = sys.id;
  return { pkg: sys.pkg, title: g.title, system: sys.id };
}

// Upload + install an APK into just this session (not saved to library).
app.post('/api/sessions/:id/apk', upload.single('apk'), chunked.adopt('apk'), long(async req => {
  const s = sessionOr404(req);
  if (!req.file) throw Object.assign(new Error('no file'), { status: 400 });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!bundle.PACKAGE_RE.test(ext)) { await fs.rm(req.file.path, { force: true }); throw bad('must be .apk, .apkm, .apks or .xapk'); }
  const apk = req.file.path + ext;
  await fs.rename(req.file.path, apk);
  try {
    if (await plusRefusesApk(req.user, apk)) throw plus.needPlusError();
    const pkgs = await s.installApk(apk);
    if (pkgs[0]) { await startGame(s, null, pkgs[0]); s.game ??= pkgs[0]; }   // it becomes the session's game
    return { packages: pkgs };
  } finally {
    await fs.rm(apk, { force: true });
  }
}));

// Push any file (game files, emulator firmware/keys you own, etc.) to /sdcard/Download.
app.post('/api/sessions/:id/file', upload.single('file'), chunked.adopt('file'), long(async req => {
  const s = sessionOr404(req);
  if (!req.file) throw Object.assign(new Error('no file'), { status: 400 });
  const remote = `/sdcard/Download/${safeName(req.file.originalname)}`;
  try {
    await s.adb.push(req.file.path, remote);
    await s.adb.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${remote}"`).catch(() => {});
    return { path: remote };
  } finally {
    await fs.rm(req.file.path, { force: true });
  }
}));

// Push a file from the server-side files/ dir (handy for large files you don't want to re-upload).
app.get('/api/files', wrap(async (req, res) => {
  res.json((await fs.readdir(config.fileDir).catch(() => [])).filter(n => !n.startsWith('.')));
}));
app.post('/api/sessions/:id/push', long(async req => {
  const s = sessionOr404(req);
  const name = safeName(req.body.file);
  await pushCompanion(s, name);
  return { path: `/sdcard/Download/${name}` };
}));

// Launch: { game } boots a console game straight into its emulator; otherwise { pkg } opens an app.
app.post('/api/sessions/:id/launch', long(async req => {
  const s = sessionOr404(req);
  const g = req.body.game ? await library.get(String(req.body.game)) : null;
  if (g?.system) {
    await startGame(s, g);
  } else {
    // Only an app installed in this session (a game): never Android's own apps (Settings, ...),
    // which would let a player out of the game onto the device.
    const pkg = String(req.body.pkg || g?.pkg || '');
    if (await plusRefusesPkg(req, pkg)) throw plus.needPlusError();
    if (!(await s.adb.listThirdPartyPackages()).has(pkg)) throw bad('that game is not installed in this session', 404);
    await startGame(s, null, pkg);
  }
  if (g && !s.game) s.game = g.title;
  return { ok: true };
}));

app.get('/upload', (req, res) => res.redirect('/#upload'));
app.use(express.static(new URL('../public', import.meta.url).pathname, { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));

// ---- WebSocket: video out (binary), input in (JSON) ----
const server = http.createServer(app);
// One upgrade router: a WebSocketServer bound to the http server answers 400 to every path it
// doesn't own, so /ws and the node tunnel can't each have their own.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024, handleProtocols });
function onUpgrade(req, sock, head) {
  let p;
  try { p = new URL(req.url, 'http://x').pathname; } catch { return sock.destroy(); }
  if (p === '/ws' && NODE) return wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
  if (p === '/ws') {
    // Accounts: the token comes as the "rose.auth.<jwt>" subprotocol (auth.js), checked before the stream opens.
    return wsUser(req).then(
      user => { req.user = user; wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req)); },
      e => wss.handleUpgrade(req, sock, head, ws => ws.close(e.status === 403 ? 4003 : 4001, 'sign in')));
  }
  if (p === '/node/tunnel' && nodes) {
    try { return nodes.handleUpgrade(req, sock, head); } catch (e) { console.error(e); return sock.destroy(); }
  }
  sock.destroy();
}
server.on('upgrade', onUpgrade);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (crossSite(req)) return ws.close(4003, 'cross-site');   // another site's page can't drive a session
  if (!authorized(url.searchParams.get('token'))) return ws.close(4001, 'unauthorized');
  const id = url.searchParams.get('session');
  const owner = id && ownerOf(id);
  if (req.user && owner && owner !== req.user.id) return ws.close(4003, 'not your session');
  // A node's session: relayed. Its "Restart game" is checked here, since the node never checks Rose+.
  if (id && manager.isRemote(id)) return nodes.attachViewer(ws, id, rs => plusMayRelaunch(req.user, rs.plusGame));
  const s = manager.get(id);
  if (!s?.scrcpy) return ws.close(4004, 'no such session');
  ws.binaryType = 'nodebuffer';
  s.addViewer(ws);
  const sc = s.scrcpy;

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // Clamped, blocked keys dropped, only known fields (tunnel.js: the same filter nodes get).
    m = sanitizeInput(m);
    if (!m) return;
    // Page hidden/shown (document.visibilityState): not player input, so it doesn't count as activity.
    if (m.t === 'hidden' || m.t === 'visible') return s.setHidden(ws, m.t === 'hidden');
    // Game audio on/off for this viewer (kinds 3/4); sent on connect and on mute, so not activity either.
    if (m.t === 'audio') return s.setAudio(ws, m.on);
    s.lastSeen = Date.now();
    switch (m.t) {
      case 'touch': sc.touch(m.a, m.id, m.x, m.y, m.w, m.h, m.p); break;
      case 'key': sc.key(m.a, m.k, 0, m.m); break;
      case 'text': sc.text(m.s); break;
      case 'scroll': sc.scroll(m.x, m.y, m.w, m.h, m.hs, m.vs); break;
      case 'nav': sc.key(0, NAV[m.k]); sc.key(1, NAV[m.k]); break;
      case 'relaunch':   // "Restart game" after it closed: a new launch, so a Switch game needs Rose+ again
        plusMayRelaunch(req.user, plus.emulatorPkg(s.watch?.pkg))
          .then(ok => (ok ? s.relaunchGame() : ws.readyState === 1 && ws.send(JSON.stringify({ t: 'game', state: 'exited' }))))
          .catch(() => {});
        break;
      case 'rotate': sc.rotate(); break;
      case 'keyframe': ws.needsKey = true; sc.resetVideo(); break;
      case 'ping': ws.send(JSON.stringify({ t: 'pong', ts: m.ts })); break;
      case 'pad': {                       // controller state (gamepad.js), already sanitized
        const { t, i: slot, ...state } = m;
        s.pad(slot, state);
        (ws.pads ??= new Set()).add(slot);
        break;
      }
    }
  });
  ws.on('close', () => {
    for (const slot of ws.pads || []) s.releasePad(slot);   // don't leave buttons held down
    s.removeViewer(ws);
  });
  ws.on('error', () => {});
});

await fs.mkdir(config.apkDir, { recursive: true });
await fs.mkdir(config.fileDir, { recursive: true });
await fs.mkdir(coverDir(), { recursive: true });
for (const id of Object.keys(emulators.SYSTEMS)) await fs.mkdir(path.join(config.romDir, id), { recursive: true });
// moveUpload's temp copies left behind by a restart mid-copy (hidden, so nothing else sees them).
for (const dir of [config.apkDir, coverDir(), ...Object.keys(emulators.SYSTEMS).map(id => path.join(config.romDir, id))]) {
  for (const f of await fs.readdir(dir).catch(() => [])) {
    if (/^\.[0-9a-f]{12}\.part$/.test(f)) await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
  }
}
if (NODE && preflight().length) {
  // Nothing can run here; retry in a while (the restart policy brings it back), e.g. after modprobe.
  console.log('rose node: not starting (see above); checking again in 5 minutes');
  process.once('SIGTERM', () => process.exit(0));
  await new Promise(r => setTimeout(r, 5 * 60_000));
  process.exit(1);
}
await fetcher.init();
await manager.init();
await nodes?.init();
let agent = null;
if (NODE) {
  await new Promise(ok => server.listen(config.port, config.listenHost, ok));
  console.log(`rose node: local API on ${config.listenHost}:${config.port} (not public)`);
  agent = new NodeAgent({ manager, port: config.port, localToken: config.accessToken });
  agent.start();
} else {
  server.listen(config.port, () => console.log(`rose listening on :${config.port}`));
  if (config.tunnelPort && config.tunnelPort !== config.port) {
    // The same app on a second port, for cloudflared on the host (see clientKey).
    const tunnelServer = http.createServer(app);
    tunnelServer.on('upgrade', onUpgrade);
    tunnelServer.listen(config.tunnelPort, () => console.log(`rose listening on :${config.tunnelPort} for cloudflared on this machine`));
  }
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.log('shutting down, destroying sessions…');
    if (agent) await agent.shutdown();   // ends its sessions, tells the hub, closes the tunnel
    else await manager.shutdown();
    process.exit(0);
  });
}
