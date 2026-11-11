// Rose nodes, hub side: other people's machines that run sessions for this hub.
//
// A node is this same code in node mode (ROSE_HUB_URL + ROSE_NODE_TOKEN, node-agent.js). It dials
// OUT to the hub over one websocket (/node/tunnel, works behind NAT), and everything for its
// sessions is relayed through that tunnel: API calls for /api/sessions/:id/* and the /ws streams.
// Browsers only ever talk to the hub. Nodes are run by other people, so they are UNTRUSTED:
//   - join tokens (rn_<id>_<secret>) are made and revoked by the owner (upload password), stored hashed;
//   - a node token is valid only for /node/tunnel, /node-api/* and /node/bundle.tgz;
//   - nothing from a browser (headers, cookies, query token, IP) is ever copied into the tunnel;
//   - everything a node sends is type-checked, size-capped and rate-limited; misbehaviour earns
//     strikes, and too many quarantine the node;
//   - a node that drops or is revoked has its sessions end cleanly.
//
// Tunnel control messages (text frames, JSON; binary frame types in tunnel.js):
//  node -> hub
//   {t:'hello', proto, version, bundle, nodeBoot, specs, caps:{switch,uploads,uhid,maxGrowMb}, max, pooled, active, sessions:[rid]}
//   {t:'res', id, status, body}       reply to a req (body: the JSON the node's own API answered)
//   {t:'res.beat', id}                the op is still running (resets the hub's 60 s idle timer)
//   {t:'ack', id, got}                upload bytes received so far
//   {t:'call', id, op:'lib'}          -> {t:'reply', id, data:{version, games}}   (<= 1 per 5 s)
//   {t:'sess', rid, info}             session info changed (<= 2/s per session)
//   {t:'gone', rid}                   session ended on the node
//   {t:'hb', active, pooled, booting, max, freeMb, load1}   every 10 s
//   {t:'ws.close', chan, code, reason}
//  hub -> node
//   {t:'welcome', nodeId, name, hubBoot, policy, libraryVersion}
//   {t:'req', id, op, rid?, json?, upload?:{size,name}}   op: create|info|play|launch|push|apk|file|end
//   {t:'req.end', id} / {t:'req.abort', id}               after / instead of an upload body
//   {t:'ws.open', chan, rid} / {t:'ws.close', chan, code}
//   {t:'end', rid} {t:'claim', rid} {t:'lib', version} {t:'bye', end}
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import * as library from './library.js';
import { SYSTEMS, systemFor } from './emulators.js';
import { PROTO, T, LIMITS, frame, parseFrame, parseText, sanitizeInput, sanitizeDownText, cleanText, int } from './tunnel.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const MiB = 1024 * 1024;
const APP_DIR = new URL('..', import.meta.url).pathname;
const storeDir = () => path.join(config.apkDir, 'nodes');
const storePath = () => path.join(storeDir(), 'nodes.json');
const SCHEDULERS = ['local-first', 'nodes-first', 'balanced'];
const RID = /^[0-9a-f]{10}$/;
const TOKEN = /^rn_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const sha = s => crypto.createHash('sha256').update(s).digest();
const str = (v, max) => (typeof v === 'string' ? cleanText(v, max) : '');
const bool = v => v === true;
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; };
// Close reasons: <= 123 bytes, so plain ASCII.
const closeReason = s => cleanText(s, 100).replace(/[^\x20-\x7e]/g, '');
const VIEWERS_PER_SESSION = 6;
const INPUT_PER_SEC = 300;
const STRIKES_MAX = 20;            // per minute, then quarantine
const QUARANTINE_MS = 5 * 60_000;
const PING_MS = 10_000, PONG_DEAD_MS = 30_000;
const IDLE_CALL_MS = 60_000;
const CALL_TOTAL_MS = { create: 300_000, play: 45 * 60_000 };
const CALL_TOTAL_DEFAULT = 10 * 60_000;
const BROWSER_MAX_BUFFERED = 2 * MiB, AUDIO_MAX_BUFFERED = 256 * 1024, BROWSER_HARD_MAX = 16 * MiB;
const TRANSFERS_PER_NODE = 2;
const GRANT_MS = 10 * 60_000;
// Hub -> node bytes the hub will hold for a node that doesn't read (then it is dropped), codec-config
// packet size (SPS/PPS and OpusHead are tiny), node control-text rate, tunnels still waiting for hello.
const TUNNEL_OUT_MAX = 32 * MiB;
const CONFIG_PACKET_MAX = 64 * 1024;
const TEXT_PER_SEC = 200, TEXT_BURST = 1000, TEXT_BYTES_PER_SEC = 2 * MiB, TEXT_BYTES_BURST = 8 * MiB;
const PENDING_PER_NODE = 3;
const gzip = (b, o) => new Promise((ok, no) => zlib.gzip(b, o || {}, (e, out) => (e ? no(e) : ok(out))));

/** Session info from a node: only these fields, every one checked. id/host/uploads come from the hub. */
function sanitizeInfo(i) {
  const o = i && typeof i === 'object' ? i : {};
  return {
    state: ['booting', 'ready', 'active'].includes(o.state) ? o.state : 'active',
    width: num(o.width, 0, 10000) || undefined, height: num(o.height, 0, 10000) || undefined,
    memoryMb: num(o.memoryMb, 0, 1e6), cpus: num(o.cpus, 0, 256),
    apps: Array.isArray(o.apps) ? o.apps.slice(0, 200).filter(a => typeof a === 'string').map(a => cleanText(a, 200)) : [],
    game: typeof o.game === 'string' ? cleanText(o.game, 200) : null,
    uhid: bool(o.uhid), audio: bool(o.audio),
    uptimeSec: num(o.uptimeSec, 0, 1e8),
  };
}

/** A node's reply to an op, reduced to what that op may return. */
function cleanBody(op, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'The host sent a bad reply.', status: 502 };
  if (b.error != null) {
    // needPlus: it refused an emulator because the hub said noEmulator (index.js), so the page opens the profile.
    return { error: cleanText(b.error, 300) || 'The host reported an error.', status: Number.isFinite(Number(b.status)) ? int(b.status, 400, 599) : 500,
      ...(b.queue === true ? { queue: true } : {}), ...(b.needPlus === true ? { needPlus: true } : {}) };
  }
  switch (op) {
    case 'create': case 'info': return { ...sanitizeInfo(b), rid: typeof b.id === 'string' ? b.id : '' };
    case 'play': return { pkg: str(b.pkg, 200), title: str(b.title, 200), ...(typeof b.system === 'string' ? { system: str(b.system, 20) } : {}) };
    case 'push': case 'file': return { path: str(b.path, 300) };
    case 'apk': return { packages: Array.isArray(b.packages) ? b.packages.slice(0, 50).filter(p => typeof p === 'string').map(p => cleanText(p, 200)) : [] };
    default: return { ok: true };
  }
}

/** Library entry fields a node needs to play it (no reviews, covers, credits, meta). */
const LIB_FIELDS = ['id', 'title', 'category', 'system', 'apk', 'rom', 'apkUrl', 'apkName', 'romUrl', 'romPath', 'romName', 'romTree',
  'sha256', 'size', 'pkg', 'file', 'fileName', 'controls', 'emulator', 'systemName'];
const trimEntry = g => Object.fromEntries(LIB_FIELDS.filter(k => g[k] !== undefined && g[k] !== null).map(k => [k, g[k]]));

/** A session that runs on a node. The hub knows it by a public id; the node's own id (rid) never reaches browsers. */
class RemoteSession {
  constructor(reg, nodeId, rid, info) {
    this.reg = reg;
    this.nodeId = nodeId;
    this.rid = rid;
    this.id = reg.newId();
    this.cached = info;
    this.viewers = new Set();         // hub-side browser sockets
    this.lastSeen = Date.now();
    this.activatedAt = Date.now();
    this.startedAt = Date.now() - (info.uptimeSec || 0) * 1000;
    this.hiddenSince = 0;
    this.detached = false;            // its node is offline (it may come back within NODE_GRACE_SEC)
    this.detachedAt = 0;
    this.sessTokens = 4; this.sessAt = Date.now();
    this.plusGame = false;            // what it last launched is Switch content (Rose+: set and read in index.js)
  }

  get state() { return this.detached ? 'detached' : this.cached.state; }

  updateHidden() {
    const all = this.viewers.size > 0 && [...this.viewers].every(ws => ws.hidden);
    this.hiddenSince = all ? this.hiddenSince || Date.now() : 0;
  }

  info() {
    const { rid, ...i } = this.cached;
    const rec = this.reg.recs.get(this.nodeId);
    const conn = this.reg.conns.get(this.nodeId);
    return {
      ...i, id: this.id, viewers: this.viewers.size, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      host: { name: rec?.name || 'a community host', kind: 'node' },
      uploads: !!conn?.caps?.uploads,
    };
  }
}

export class NodeRegistry {
  /**
   * manager: the SessionManager (for local capacity in the scheduler). libraryVersion: () => Promise<number>.
   * clientKey: (req) => string, the client a request comes from (for the token-guessing limit).
   */
  constructor({ manager, libraryVersion, clientKey }) {
    this.manager = manager;
    this.libraryVersion = libraryVersion;
    this.clientKey = clientKey;
    this.recs = new Map();            // node id -> stored record
    this.settings = { scheduler: SCHEDULERS.includes(config.scheduler) ? config.scheduler : 'local-first' };
    this.conns = new Map();           // node id -> live tunnel (welcomed)
    this.nodeSessions = new Map();    // node id -> { boot, sessions: Map rid -> RemoteSession }
    this.sessions = new Map();        // public id -> RemoteSession
    this.quarantine = new Map();      // node id -> until
    this.grants = new Map();          // `${nodeId}\n${name}` -> expiry (one-time file grants for /push)
    this.transfers = new Map();       // node id -> running /node-api/files downloads
    this.misses = new Map();          // client -> { n, last, until }
    this.hashes = new Map();          // file path -> { size, mtimeMs, sha256 }
    this.hubBoot = crypto.randomBytes(8).toString('hex');
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: LIMITS.TUNNEL_MAX_PAYLOAD });
    this.libVersion = null;
    this.writing = Promise.resolve();
    this.httpRate = new Map();        // node id -> { n, at }: /node-api request budget
    this.pending = new Map();         // node id -> tunnels open but not yet past hello
    this.fileRes = new Map();         // node id -> Set of /node-api/files responses in progress (revoke aborts them)
  }

  // ---------------------------------------------------------------- store
  async init() {
    await fs.mkdir(storeDir(), { recursive: true, mode: 0o700 });
    const db = JSON.parse(await fs.readFile(storePath(), 'utf8').catch(() => '{}'));
    for (const r of db.nodes || []) if (r?.id && r.hash) this.recs.set(r.id, r);
    if (SCHEDULERS.includes(db.settings?.scheduler)) this.settings.scheduler = db.settings.scheduler;
    setInterval(() => this.tick().catch(e => log(`nodes: tick: ${e.message}`)), PING_MS).unref();
    if (this.recs.size) log(`nodes: ${this.recs.size} join token(s), placement ${this.settings.scheduler}`);
  }

  save() {
    const data = JSON.stringify({ nodes: [...this.recs.values()], settings: this.settings }, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${storePath()}.tmp`;
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, storePath());
    }).catch(e => log(`nodes: could not save ${storePath()}: ${e.message}`));
    return this.writing;
  }

  newId() {
    let id;
    do id = crypto.randomBytes(5).toString('hex'); while (this.sessions.has(id) || this.manager.sessions.has(id));
    return id;
  }

  // ---------------------------------------------------------------- tokens / auth
  /** Too many wrong tokens from one client: refuse it for a while (same rule as the upload password). */
  guard(req, ok) {
    const now = Date.now(), key = this.clientKey(req);
    let m = this.misses.get(key);
    if (m && m.until > now) return 'locked';
    if (ok) { this.misses.delete(key); return 'ok'; }
    if (!m || m.until || now - m.last > 15 * 60_000) m = { n: 0 };
    m.n++; m.last = now; m.until = m.n >= 10 ? now + 10 * 60_000 : 0;
    this.misses.delete(key); this.misses.set(key, m);
    for (const k of this.misses.keys()) { if (this.misses.size <= 10_000) break; this.misses.delete(k); }
    return m.until ? 'locked' : 'wrong';
  }

  /** The node record a bearer token belongs to, or null. Never accepts anything but "Authorization: Bearer". */
  tokenRecord(req) {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(\S+)$/i.exec(h)?.[1]?.match(TOKEN);
    const rec = m && this.recs.get(m[1]);
    // Always one hash compare, found or not.
    const want = rec ? Buffer.from(rec.hash, 'hex') : Buffer.alloc(32);
    const got = sha(m ? m[2] : 'x');
    return crypto.timingSafeEqual(want, got) && rec ? rec : null;
  }

  /** Express middleware: a valid node token (disabled nodes may still fetch files for running sessions). */
  requireNode() {
    return (req, res, next) => {
      const rec = this.tokenRecord(req);
      const g = this.guard(req, !!rec);
      if (g === 'locked') return res.status(429).json({ error: 'too many wrong tokens' });
      if (!rec) return res.status(401).json({ error: 'bad node token' });
      if ((this.quarantine.get(rec.id) || 0) > Date.now()) return res.status(503).json({ error: 'held back' });
      // Every /node-api call reads the library: 10 a second per node (bursts of 40) is plenty.
      const now = Date.now(), r = this.httpRate.get(rec.id) || { n: 40, at: now };
      r.n = Math.min(40, r.n + (now - r.at) / 100); r.at = now;
      this.httpRate.set(rec.id, r);
      if (r.n < 1) return res.status(429).json({ error: 'slow down' });
      r.n--;
      req.nodeRec = rec;
      next();
    };
  }

  createToken(name) {
    let id;
    do id = crypto.randomBytes(4).toString('hex'); while (this.recs.has(id));
    const secret = crypto.randomBytes(32).toString('base64url');
    const rec = { id, name: cleanName(name) || `host-${id}`, hash: sha(secret).toString('hex'), createdAt: Date.now(),
      disabled: false, cap: 0, lastSeen: 0, lastSpecs: null, bootId: null };
    this.recs.set(id, rec);
    this.save();
    log(`nodes: join token created for "${rec.name}" (${id})`);
    return { id, name: rec.name, token: `rn_${id}_${secret}` };
  }

  revoke(id) {
    const rec = this.recs.get(id);
    if (!rec) return false;
    this.endNodeSessions(id);
    const c = this.conns.get(id);
    if (c) { c.ws.close(4401, 'token revoked'); this.drop(c, 'revoked'); }
    this.recs.delete(id);   // after drop(), which logs the host's name from it
    this.dropSessions(id);
    for (const res of this.fileRes.get(id) || []) res.destroy();   // downloads in progress stop too
    this.fileRes.delete(id);
    this.save();
    log(`nodes: token for "${rec.name}" (${id}) revoked`);
    return true;
  }

  endNodeSessions(id) {
    for (const rs of [...(this.nodeSessions.get(id)?.sessions.values() || [])]) this.end(rs.id);
  }

  // ---------------------------------------------------------------- tunnel
  /** HTTP upgrade for /node/tunnel. Everything is checked before the websocket exists. */
  handleUpgrade(req, sock, head) {
    const refuse = (code, text) => {
      sock.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`);
      sock.destroy();
    };
    if (req.headers.origin) return refuse(403, 'Forbidden');          // never from a browser
    const rec = this.tokenRecord(req);
    const g = this.guard(req, !!rec);
    if (g === 'locked') return refuse(429, 'Too Many Requests');
    if (!rec) return refuse(401, 'Unauthorized');
    if (rec.disabled) return refuse(403, 'Forbidden');
    if ((this.quarantine.get(rec.id) || 0) > Date.now()) return refuse(503, 'Service Unavailable');
    if (!this.conns.has(rec.id) && this.conns.size >= config.nodeMax) return refuse(503, 'Service Unavailable');
    // At most a few tunnels per token may sit before their hello (each holds a socket for 10 s).
    if ((this.pending.get(rec.id) || 0) >= PENDING_PER_NODE) return refuse(429, 'Too Many Requests');
    this.pending.set(rec.id, (this.pending.get(rec.id) || 0) + 1);
    let counted = true;
    const unpend = () => {
      if (!counted) return;
      counted = false;
      const n = (this.pending.get(rec.id) || 1) - 1;
      if (n > 0) this.pending.set(rec.id, n); else this.pending.delete(rec.id);
    };
    sock.once('close', unpend);
    this.wss.handleUpgrade(req, sock, head, ws => this.onTunnel(ws, rec, unpend));
  }

  onTunnel(ws, rec, unpend = () => {}) {
    const c = {
      id: rec.id, ws, ready: false, dropped: false, connectedAt: Date.now(), lastPong: Date.now(), pingAt: 0, rtt: null,
      specs: {}, caps: {}, max: 0, active: 0, pooled: 0, booting: 0, freeMb: 0, load1: 0, version: '', bundle: '',
      pendingCreates: 0, strikes: [], failures: [], degradedUntil: 0, calls: new Map(), chans: new Map(), chanSeq: 0, reqSeq: 0,
      bucket: 0, bucketAt: Date.now(), budgetStrikeAt: 0, libCallAt: 0,
      txtN: TEXT_BURST, txtB: TEXT_BYTES_BURST, txtAt: Date.now(), rateStrikeAt: 0,
    };
    const helloTimer = setTimeout(() => { unpend(); ws.close(4400, 'no hello'); }, 10_000);
    ws.on('pong', () => {
      const now = Date.now();
      c.lastPong = now;
      if (c.pingAt) { const s = now - c.pingAt; c.rtt = c.rtt == null ? s : Math.round(c.rtt * 0.7 + s * 0.3); c.pingAt = 0; }
    });
    ws.on('message', (data, isBinary) => {
      if (c.dropped) return;
      if (!c.ready) {
        clearTimeout(helloTimer);
        unpend();
        if (isBinary) return ws.close(4400, 'hello first');
        // (outside the try below: an exception here would otherwise be an uncaught one in the hub)
        try { return this.onHello(c, rec, data); } catch (e) { log(`nodes: ${rec.id}: bad hello: ${e.message}`); return ws.close(4400, 'bad hello'); }
      }
      try {
        if (isBinary) this.onBinary(c, data);
        else if (this.textBudget(c, data.length)) this.onText(c, data);
      } catch (e) {
        log(`nodes: ${rec.id}: message error: ${e.message}`);
        this.strike(c, 'bad message');
      }
    });
    ws.on('close', (code) => { clearTimeout(helloTimer); unpend(); this.drop(c, `closed ${code}`); });
    ws.on('error', () => {});
  }

  onHello(c, rec, raw) {
    const ws = c.ws;
    const m = parseText(raw, LIMITS.HELLO_MAX);
    if (!m || m.t !== 'hello') return ws.close(4400, 'hello expected');
    if (m.proto !== PROTO) return ws.close(4426, 'update your node');
    if (!this.recs.has(rec.id) || rec.disabled) return ws.close(4401, 'token revoked');
    const nodeBoot = typeof m.nodeBoot === 'string' && /^[\w-]{8,64}$/.test(m.nodeBoot) ? m.nodeBoot : null;
    if (!nodeBoot) return ws.close(4400, 'bad hello');
    const sp = m.specs && typeof m.specs === 'object' ? m.specs : {};
    c.specs = {
      cpuModel: str(sp.cpuModel, 100), threads: int(sp.threads, 0, 1024), ramMb: int(sp.ramMb, 0, 1e7), gpu: bool(sp.gpu),
      binder: bool(sp.binder), uhid: bool(sp.uhid), kernel: str(sp.kernel, 100), arch: str(sp.arch, 20), wsl: bool(sp.wsl),
    };
    const cp = m.caps && typeof m.caps === 'object' ? m.caps : {};
    c.caps = { switch: bool(cp.switch), uploads: bool(cp.uploads), uhid: bool(cp.uhid), maxGrowMb: int(cp.maxGrowMb, 0, 1e6) };
    c.version = str(m.version, 40);
    c.bundle = typeof m.bundle === 'string' && /^[0-9a-f]{64}$/.test(m.bundle) ? m.bundle : '';
    c.max = int(m.max, 0, 64); c.pooled = int(m.pooled, 0, 64); c.active = int(m.active, 0, 64);
    const listed = new Set(Array.isArray(m.sessions) ? m.sessions.slice(0, 64).filter(r => typeof r === 'string' && RID.test(r)) : []);

    // Same token again: the newest tunnel wins.
    const old = this.conns.get(rec.id);
    if (old && old !== c) { old.ws.close(4409, 'replaced by a new connection'); this.drop(old, 'replaced'); }

    // Its sessions: a node that restarted (new nodeBoot) lost them all; otherwise the ones both
    // sides still know resume, and the node ends the ones the hub forgot.
    let st = this.nodeSessions.get(rec.id);
    if (!st || st.boot !== nodeBoot) {
      if (st) this.dropSessions(rec.id);
      st = { boot: nodeBoot, sessions: new Map() };
      this.nodeSessions.set(rec.id, st);
    }
    for (const rs of [...st.sessions.values()]) {
      if (listed.has(rs.rid)) { rs.detached = false; rs.detachedAt = 0; } else this.remove(rs);
    }
    c.ready = true;
    this.conns.set(rec.id, c);
    for (const rid of listed) if (!st.sessions.has(rid)) this.send(c, { t: 'end', rid });

    rec.lastSeen = Date.now(); rec.lastSpecs = c.specs; rec.bootId = nodeBoot; rec.version = c.version; rec.caps = c.caps;
    this.save();
    this.libraryVersion().then(v => {
      if (c.dropped) return;
      this.send(c, { t: 'welcome', nodeId: rec.id, name: rec.name, hubBoot: this.hubBoot, libraryVersion: v,
        policy: { idleTimeoutSec: config.idleTimeoutSec, hiddenTimeoutSec: config.hiddenTimeoutSec, maxSessionMin: config.maxSessionMin, maxBitrate: config.bitrate } });
      c.pingAt = Date.now();
      c.ws.ping();
    }, () => {});
    log(`nodes: "${rec.name}" (${rec.id}) online: ${c.specs.cpuModel || '?'} ${c.specs.threads}t ${Math.round(c.specs.ramMb / 1024)} GB, `
      + `max ${c.max}, ${st.sessions.size} session(s) resumed, version ${c.version || '?'}`);
  }

  send(c, msg) { this.out(c, JSON.stringify(msg)); }

  /**
   * Everything the hub sends a node goes through here: a node that stops reading its tunnel is
   * dropped, so it can never pile up the hub's memory (uploads also wait for the socket, see call()).
   */
  out(c, data) {
    if (c.dropped || c.ws.readyState !== 1) return false;
    if (c.ws.bufferedAmount > TUNNEL_OUT_MAX) {
      log(`nodes: ${c.id}: not reading its tunnel (${Math.round(c.ws.bufferedAmount / MiB)} MiB queued): dropping it`);
      c.ws.terminate();
      this.drop(c, 'not reading');
      return false;
    }
    c.ws.send(data);
    return true;
  }

  /** Control text from a node: TEXT_PER_SEC messages and TEXT_BYTES_PER_SEC, with bursts. Over: dropped, and a strike. */
  textBudget(c, bytes) {
    const now = Date.now(), dt = (now - c.txtAt) / 1000;
    c.txtAt = now;
    c.txtN = Math.min(TEXT_BURST, c.txtN + dt * TEXT_PER_SEC);
    c.txtB = Math.min(TEXT_BYTES_BURST, c.txtB + dt * TEXT_BYTES_PER_SEC);
    if (c.txtN < 1 || c.txtB < bytes) {
      if (now - c.rateStrikeAt > 1000) { c.rateStrikeAt = now; this.strike(c, 'control messages too fast'); }
      return false;
    }
    c.txtN--; c.txtB -= bytes;
    return true;
  }

  /** Too many bad messages within a minute: disconnect it and keep it out for a while. */
  strike(c, why) {
    const now = Date.now();
    c.strikes = c.strikes.filter(t => now - t < 60_000);
    c.strikes.push(now);
    if (c.strikes.length === 1 || c.strikes.length % 5 === 0) log(`nodes: ${c.id}: strike (${why}), ${c.strikes.length} in the last minute`);
    if (c.strikes.length > STRIKES_MAX && !c.dropped) {
      log(`nodes: ${c.id}: quarantined for ${QUARANTINE_MS / 60_000} min (misbehaving)`);
      this.quarantine.set(c.id, now + QUARANTINE_MS);
      c.ws.close(4400, 'misbehaving');
      this.drop(c, 'quarantined');
    }
  }

  onText(c, raw) {
    const m = parseText(raw, LIMITS.RES_MAX);
    if (!m) return this.strike(c, 'bad text frame');
    if (m.t !== 'res' && raw.length > LIMITS.TEXT_MAX) return this.strike(c, 'oversized text');
    const sess = () => (typeof m.rid === 'string' ? this.nodeSessions.get(c.id)?.sessions.get(m.rid) : null);
    switch (m.t) {
      case 'res': {
        const p = c.calls.get(m.id);
        if (p) p.finish(cleanBody(p.op, m.body));
        return;
      }
      case 'res.beat': c.calls.get(m.id)?.beat(); return;
      case 'ack': c.calls.get(m.id)?.ack(Number(m.got) || 0); return;
      case 'hb':
        c.active = int(m.active, 0, 64); c.pooled = int(m.pooled, 0, 64); c.booting = int(m.booting, 0, 64);
        c.max = int(m.max, 0, 64); c.freeMb = int(m.freeMb, 0, 1e8); c.load1 = num(m.load1, 0, 1e4);
        return;
      case 'sess': {
        const rs = sess();
        if (!rs) return;   // the hub ended it a moment ago (floods: textBudget)
        const now = Date.now();
        rs.sessTokens = Math.min(4, rs.sessTokens + (now - rs.sessAt) / 500); rs.sessAt = now;
        if (rs.sessTokens < 1) return;
        rs.sessTokens--;
        rs.cached = { ...sanitizeInfo(m.info), rid: rs.rid };
        return;
      }
      case 'gone': {
        const rs = sess();
        if (!rs) return;   // the hub may have ended it first
        log(`nodes: ${c.id}: session ${rs.id} ended on the host`);
        this.remove(rs);
        return;
      }
      case 'ws.close': {
        const v = c.chans.get(m.chan);
        if (!v) { if (!(Number.isInteger(m.chan) && m.chan > 0 && m.chan <= c.chanSeq)) this.strike(c, 'unknown chan'); return; }
        c.chans.delete(m.chan);
        if (m.code === 1000) v.ws.close(1000, 'session ended');
        else v.ws.close(4502, closeReason(typeof m.reason === 'string' && m.reason ? m.reason : 'The stream from the host closed'));
        return;
      }
      case 'call': {
        const now = Date.now();
        if (m.op !== 'lib' || !Number.isInteger(m.id)) return this.strike(c, 'bad call');
        if (now - c.libCallAt < 5000) { this.send(c, { t: 'reply', id: m.id, error: 'slow down' }); return this.strike(c, 'lib calls too fast'); }
        c.libCallAt = now;
        this.nodeLibrary(c).then(data => this.send(c, { t: 'reply', id: m.id, data }),
          e => this.send(c, { t: 'reply', id: m.id, error: cleanText(e.message, 200) }));
        return;
      }
      default: return this.strike(c, `unknown message ${cleanText(m.t, 20)}`);
    }
  }

  /** Stream data the node sends one browser. Same drop policy as a local Session, plus a byte budget per node. */
  onBinary(c, buf) {
    const f = parseFrame(buf);
    if (!f) return this.strike(c, 'short binary frame');
    if (f.type !== T.WS_DOWN && f.type !== T.WS_DOWN_TXT) return this.strike(c, 'bad frame type');
    const v = c.chans.get(f.chan);
    if (!v) { if (!(f.chan > 0 && f.chan <= c.chanSeq)) this.strike(c, 'unknown chan'); return; }   // else: closed a moment ago
    const ws = v.ws;
    if (ws.readyState !== 1) return;
    if (f.type === T.WS_DOWN_TXT) {
      const m = f.payload.length <= 1024 ? sanitizeDownText(parseText(f.payload.toString('utf8'), 1024)) : null;
      if (!m) return this.strike(c, 'bad stream text');
      ws.send(JSON.stringify(m));
      return;
    }
    const kind = f.payload[0];
    if (f.payload.length < 1 || kind > 4) return this.strike(c, 'bad packet kind');
    // Token bucket: NODE_MAX_MBPS for all of this node's streams, 2 s of burst.
    const rate = config.nodeMaxMbps * 125_000, now = Date.now();
    c.bucket = Math.min(rate * 2, c.bucket + (now - c.bucketAt) / 1000 * rate); c.bucketAt = now;
    if (c.bucket < f.payload.length) {
      if (kind === 1 || kind === 2) { v.needsKey = true; this.askKey(c, v); }
      if (now - c.budgetStrikeAt > 5000) { c.budgetStrikeAt = now; this.strike(c, 'over its bandwidth budget'); }
      return;
    }
    c.bucket -= f.payload.length;
    if ((kind === 0 || kind === 3) && f.payload.length > CONFIG_PACKET_MAX) return this.strike(c, 'oversized codec config');
    if (ws.bufferedAmount > BROWSER_HARD_MAX) {
      // Codec configs pass any backlog for a local session; from an untrusted node that would be
      // unbounded hub memory for a browser that doesn't read. Such a viewer is closed instead.
      if (kind === 0 || kind === 3) {
        c.chans.delete(f.chan);
        this.send(c, { t: 'ws.close', chan: f.chan, code: 1000 });
        ws.close(4502, 'connection too slow');
      } else v.needsKey = true;
      return;
    }
    if (kind === 2) {
      // Delta frames for a backed-up browser are dropped; it catches up on the next keyframe.
      if (ws.bufferedAmount > BROWSER_MAX_BUFFERED) v.needsKey = true;
      if (v.needsKey) return this.askKey(c, v);
    }
    if (kind === 1) v.needsKey = false;
    if (kind === 4 && ws.bufferedAmount > AUDIO_MAX_BUFFERED) return;
    ws.send(f.payload);
  }

  /** Ask the node's session for a keyframe for this viewer, at most once a second. */
  askKey(c, v) {
    const now = Date.now();
    if (now - v.keyAt < 1000 || c.dropped) return;
    v.keyAt = now;
    this.out(c, frame(T.WS_UP_TXT, v.chan, JSON.stringify({ t: 'keyframe' })));
  }

  /** The tunnel is gone: its sessions wait NODE_GRACE_SEC for it to come back (see onHello). */
  drop(c, why) {
    if (c.dropped) return;
    c.dropped = true;
    const was = this.conns.get(c.id) === c;
    if (was) this.conns.delete(c.id);
    const rec = this.recs.get(c.id);
    const name = rec?.name || c.id;
    for (const p of [...c.calls.values()]) p.finish(offline(name));
    for (const v of c.chans.values()) v.ws.close(4502, closeReason(`The host ${name} went offline`));
    c.chans.clear();
    for (const rs of this.nodeSessions.get(c.id)?.sessions.values() || []) {
      if (!rs.detached) { rs.detached = true; rs.detachedAt = Date.now(); }
    }
    if (was && rec) { rec.lastSeen = Date.now(); this.save(); }
    if (c.ready) log(`nodes: "${name}" (${c.id}) offline (${why})`);
    if (c.ws.readyState === 0 || c.ws.readyState === 1) c.ws.close(1001, 'bye');
  }

  /** Forget a node's sessions without telling it (it restarted, or it is gone for good). */
  dropSessions(id) {
    for (const rs of [...(this.nodeSessions.get(id)?.sessions.values() || [])]) this.remove(rs);
    this.nodeSessions.delete(id);
  }

  /** Forget one remote session (the node already ended it, or will be told by end()). */
  remove(rs, { code = 1000, reason = 'session ended' } = {}) {
    if (this.sessions.get(rs.id) !== rs) return;
    this.sessions.delete(rs.id);
    this.nodeSessions.get(rs.nodeId)?.sessions.delete(rs.rid);
    const c = this.conns.get(rs.nodeId);
    if (c) for (const [chan, v] of c.chans) if (v.rs === rs) c.chans.delete(chan);
    for (const ws of rs.viewers) ws.close(code, reason);
    rs.viewers.clear();
  }

  // ---------------------------------------------------------------- RPC
  /**
   * Run an op on a node (the node replays it against its own API). Resolves with the cleaned reply
   * body; on errors {error, status}. Never rejects. `file`: {path, size, name} to stream as the upload.
   */
  call(c, op, { rid, json, file } = {}) {
    const name = this.recs.get(c?.id)?.name || 'host';
    return new Promise(resolve => {
      if (!c || c.dropped) return resolve(offline(name));
      c.reqSeq = (c.reqSeq % 0xfffffffe) + 1;
      const id = c.reqSeq;
      let idle, total, ackWait = null, drainTimer = null;
      const p = {
        op, acked: 0, done: false,
        finish: body => {
          if (p.done) return;
          p.done = true;
          clearTimeout(idle); clearTimeout(total); clearTimeout(drainTimer);
          c.calls.delete(id);
          ackWait?.();
          resolve(body);
        },
        beat: () => { clearTimeout(idle); idle = setTimeout(() => timeout('stopped answering'), IDLE_CALL_MS); },
        ack: got => { p.acked = Math.max(p.acked, Math.min(got, p.sent || 0)); p.beat(); ackWait?.(); },
        sent: 0,
      };
      const timeout = what => {
        log(`nodes: ${c.id}: ${op} ${what}`);
        this.send(c, { t: 'req.abort', id });
        p.finish({ error: `The host ${name} ${what}. Try again.`, status: 504 });
      };
      p.beat();
      total = setTimeout(() => timeout('took too long'), CALL_TOTAL_MS[op] || CALL_TOTAL_DEFAULT);
      c.calls.set(id, p);
      this.send(c, { t: 'req', id, op, ...(rid ? { rid } : {}), ...(json ? { json } : {}), ...(file ? { upload: { size: file.size, name: file.name } } : {}) });
      if (!file) return;
      // Upload body: REQ_BODY chunks, at most UPLOAD_WINDOW unacked.
      (async () => {
        const stream = createReadStream(file.path, { highWaterMark: LIMITS.REQ_CHUNK });
        try {
          for await (const chunk of stream) {
            // Acks alone can't be trusted (a node can ack bytes it never read): also wait (polling) for
            // the socket itself to drain, so a node that doesn't read never gets the file buffered in memory.
            while (!p.done && !c.dropped && (p.sent - p.acked >= LIMITS.UPLOAD_WINDOW || c.ws.bufferedAmount >= LIMITS.UPLOAD_WINDOW)) {
              await new Promise(r => { ackWait = r; drainTimer = setTimeout(r, 50); });
              clearTimeout(drainTimer);
            }
            ackWait = null;
            if (p.done || c.dropped) return;
            if (!this.out(c, frame(T.REQ_BODY, id, chunk))) return p.finish(offline(name));
            p.sent += chunk.length;
          }
          if (!p.done) this.send(c, { t: 'req.end', id });
        } catch (e) {
          if (!p.done) { this.send(c, { t: 'req.abort', id }); p.finish({ error: 'Could not read the upload.', status: 500 }); }
        } finally {
          stream.destroy();
        }
      })();
    });
  }

  /** Run an op for a remote session (hub routes). */
  callSession(rs, op, json) {
    const c = this.conns.get(rs.nodeId);
    if (!c || rs.detached) return Promise.resolve(offline(this.recs.get(rs.nodeId)?.name));
    return this.call(c, op, { rid: rs.rid, json });
  }

  /** Stream an uploaded file (multer or chunked) into a remote session's apk/file op. */
  callUpload(rs, op, file, name) {
    const c = this.conns.get(rs.nodeId);
    if (!c || rs.detached) return Promise.resolve(offline(this.recs.get(rs.nodeId)?.name));
    if (!c.caps.uploads) return Promise.resolve({ error: 'This host does not take uploads.', status: 403 });
    if (!(file.size > 0) || file.size > LIMITS.UPLOAD_MAX) return Promise.resolve({ error: 'file too large', status: 413 });
    return this.call(c, op, { rid: rs.rid, file: { path: file.path, size: file.size, name } });
  }

  // ---------------------------------------------------------------- sessions
  get(id) { return this.sessions.get(id); }
  infos() { return [...this.sessions.values()].map(rs => rs.info()); }

  /** Library entry for an id from a browser ('' / unknown = null: any host will do). */
  async resolveGame(id) {
    if (!id || typeof id !== 'string' || id.length > 64) return null;
    return (await library.get(id)) || null;
  }

  /** Create a session on node `c`. Throws like SessionManager.create ({queue:true} = it was full). */
  async create(c, { game } = {}) {
    const rec = this.recs.get(c.id);
    c.pendingCreates++;
    let b;
    try { b = await this.call(c, 'create', { json: {} }); } finally { c.pendingCreates--; }
    if (b.error) {
      if (!b.queue) this.failed(c);
      throw Object.assign(new Error(b.error), { status: b.status || 502, queue: !!b.queue });
    }
    const st = this.nodeSessions.get(c.id);
    const rid = b.rid;
    const bad = !RID.test(rid) || !st || st.sessions.has(rid) || c.dropped;
    if (bad || st.sessions.size >= this.limit(c)) {
      if (RID.test(rid) && !st?.sessions.has(rid)) this.send(c, { t: 'end', rid });
      if (bad) { this.failed(c); throw Object.assign(new Error(`The host ${rec?.name} could not start a session.`), { status: 502 }); }
      throw Object.assign(new Error('Every rig is busy right now. You are in line.'), { status: 503, queue: true });
    }
    const rs = new RemoteSession(this, c.id, rid, { ...sanitizeInfo(b), rid });
    st.sessions.set(rid, rs);
    this.sessions.set(rs.id, rs);
    this.send(c, { t: 'claim', rid });
    log(`nodes: session ${rs.id} started on "${rec?.name}" (${c.id})${game ? ` for ${game.id}` : ''}`);
    return rs;
  }

  failed(c) {
    const now = Date.now();
    c.failures = c.failures.filter(t => now - t < 5 * 60_000);
    c.failures.push(now);
    if (c.failures.length >= 3) { c.degradedUntil = now + 2 * 60_000; c.failures = []; log(`nodes: ${c.id}: degraded for 2 min (3 failed starts)`); }
  }

  /** End a remote session: the node is told, and the hub forgets it even if the node is offline. */
  async end(id) {
    const rs = this.sessions.get(id);
    if (!rs) return;
    const c = this.conns.get(rs.nodeId);
    if (c && !rs.detached) this.send(c, { t: 'end', rid: rs.rid });
    this.remove(rs);
    log(`nodes: session ${id} ended`);
  }

  /**
   * Browser /ws for a remote session: bridged to the node over one channel of its tunnel.
   * mayRelaunch(rs) -> Promise<bool>: may this viewer restart the game ({t:'relaunch'})? (Rose+, index.js)
   */
  attachViewer(ws, id, mayRelaunch) {
    const rs = this.sessions.get(id);
    const c = rs && this.conns.get(rs.nodeId);
    if (!rs || !c || rs.detached) return ws.close(4502, 'The host is offline');
    if (rs.viewers.size >= VIEWERS_PER_SESSION) return ws.close(4429, 'too many viewers');
    if (c.chans.size >= Math.max(4, 4 * this.limit(c))) return ws.close(4429, 'host is busy');
    ws.binaryType = 'nodebuffer';
    c.chanSeq = (c.chanSeq % 0xfffffffe) + 1;
    const chan = c.chanSeq;
    const v = { ws, rs, chan, needsKey: false, keyAt: 0, n: 0, sec: 0 };
    c.chans.set(chan, v);
    rs.viewers.add(ws);
    rs.lastSeen = Date.now();
    rs.updateHidden();
    this.send(c, { t: 'ws.open', chan, rid: rs.rid });
    ws.on('message', (raw, isBinary) => {
      if (isBinary || c.chans.get(chan) !== v) return;
      const now = Date.now();
      if (now - v.sec >= 1000) { v.sec = now; v.n = 0; }
      if (++v.n > INPUT_PER_SEC) return;
      let m;
      try { m = sanitizeInput(JSON.parse(raw)); } catch { return; }
      if (!m) return;
      if (m.t === 'hidden' || m.t === 'visible') { ws.hidden = m.t === 'hidden'; rs.updateHidden(); }
      else if (m.t !== 'audio') rs.lastSeen = now;
      const up = () => this.out(c, frame(T.WS_UP_TXT, chan, JSON.stringify(m)));
      if (m.t !== 'relaunch' || !mayRelaunch) return up();
      // "Restart game" is a new launch, and the node never checks Rose+: the hub asks first.
      Promise.resolve(mayRelaunch(rs)).then(ok => {
        if (c.chans.get(chan) !== v) return;   // closed meanwhile
        if (ok) up();
        else if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'game', state: 'exited' }));
      }, () => {});
    });
    ws.on('close', () => {
      if (c.chans.get(chan) === v) { c.chans.delete(chan); this.send(c, { t: 'ws.close', chan, code: 1000 }); }
      rs.viewers.delete(ws);
      rs.lastSeen = Date.now();
      rs.updateHidden();
    });
    ws.on('error', () => {});
  }

  // ---------------------------------------------------------------- scheduler
  /** Sessions node `c` may run: the least of what it claims, NODE_MAX_SESSIONS and the owner's cap. */
  limit(c) {
    const cap = this.recs.get(c.id)?.cap || Infinity;
    return Math.max(0, Math.min(c.max, config.nodeMaxSessions, cap));
  }

  free(c) {
    const ours = this.nodeSessions.get(c.id)?.sessions.size || 0;
    return this.limit(c) - Math.max(c.active, ours) - c.booting - c.pendingCreates;
  }

  eligible(c) {
    const rec = this.recs.get(c.id);
    const now = Date.now();
    return !!rec && c.ready && !c.dropped && !rec.disabled && (this.quarantine.get(c.id) || 0) <= now && c.degradedUntil <= now
      && (c.rtt == null || c.rtt <= config.nodeMaxRttMs) && this.free(c) > 0;
  }

  /** Can node `c` run library entry `g`? (null = unknown game: yes.) */
  gameAllowed(c, g) {
    if (!g || !g.system) return true;
    // The owner's own Switch dumps need the owner's keys/firmware, which never leave the hub.
    if (g.rom && /\.(nsp|xci)$/i.test(g.rom) && !config.nodeSwitchDumps) return false;
    // Console emulators are x86_64 builds: never on an arm64 node (e.g. an Apple Silicon VM).
    if (g.system === 'switch') return !!c.caps?.switch && c.specs?.arch !== 'arm64' && (c.caps.maxGrowMb || 0) >= config.switchMemoryMb;
    return !!systemFor(g.system);
  }

  hasSlot(g) {
    for (const c of this.conns.values()) if (this.eligible(c) && this.gameAllowed(c, g)) return true;
    return false;
  }

  /** Where to try a new session, in order: 'local' and/or node tunnels. */
  order(g, place) {
    if (place === 'local') return ['local'];
    if (typeof place === 'string' && place.startsWith('node:')) {
      const c = this.conns.get(place.slice(5));
      return c && this.eligible(c) && this.gameAllowed(c, g) ? [c] : [];
    }
    const nodes = [...this.conns.values()].filter(c => this.eligible(c) && this.gameAllowed(c, g));
    const mode = this.settings.scheduler;
    if (mode === 'balanced') {
      const m = this.manager;
      const localFree = config.maxSessions ? (config.maxSessions - m.sessions.size - m.booting) / config.maxSessions : 0;
      const ranked = [{ c: 'local', frac: m.localHasSlot() ? Math.max(localFree, 1e-6) : -1, rtt: 0 },
        ...nodes.map(c => ({ c, frac: this.free(c) / Math.max(1, this.limit(c)), rtt: c.rtt ?? 0 }))];
      return ranked.sort((a, b) => b.frac - a.frac || a.rtt - b.rtt).map(x => x.c);
    }
    nodes.sort((a, b) => b.pooled - a.pooled || this.free(b) - this.free(a) || (a.rtt ?? 0) - (b.rtt ?? 0));
    if (mode === 'nodes-first') return [...nodes, 'local'];
    return this.manager.localHasSlot() ? ['local', ...nodes] : [...nodes, 'local'];
  }

  /** Node capacity for /api/stats and the waiting line. */
  capacity() {
    let max = 0, pooled = 0, booting = 0, online = 0, free = 0;
    const counted = new Set();
    for (const c of this.conns.values()) {
      if (!c.ready) continue;
      online++;
      counted.add(c.id);
      const ours = this.nodeSessions.get(c.id)?.sessions.size || 0;
      if (this.eligible(c)) {
        const f = Math.max(0, this.free(c));
        max += Math.max(this.limit(c), ours); pooled += Math.min(c.pooled, f); booting += c.booting; free += f;
      } else {
        max += ours;   // its running sessions still count, so they don't eat into the hub's own free rigs
      }
    }
    for (const [id, st] of this.nodeSessions) if (!counted.has(id)) max += st.sessions.size;   // offline, in grace
    return { max, active: this.sessions.size, pooled, booting, online, free };
  }

  // ---------------------------------------------------------------- housekeeping
  async tick() {
    const now = Date.now();
    // Liveness: ping every 10 s, give up after 30 s without a pong.
    for (const c of [...this.conns.values()]) {
      if (now - c.lastPong > PONG_DEAD_MS) { log(`nodes: ${c.id}: no pong for 30 s`); c.ws.terminate(); this.drop(c, 'timeout'); continue; }
      c.pingAt = now;
      try { c.ws.ping(); } catch {}
    }
    // Remote reaper: same idle, hidden and max-time rules as local sessions, from the hub's own view.
    for (const rs of [...this.sessions.values()]) {
      if (rs.detached) {
        if (now - rs.detachedAt > config.nodeGraceSec * 1000) { log(`nodes: session ${rs.id}: host did not come back`); this.remove(rs); }
        continue;
      }
      const idle = rs.viewers.size === 0 && now - rs.lastSeen > config.idleTimeoutSec * 1000;
      const hidden = rs.hiddenSince > 0 && now - rs.hiddenSince > config.hiddenTimeoutSec * 1000;
      const expired = now - rs.activatedAt > config.maxSessionMin * 60_000;
      if (idle || hidden || expired) { log(`reaping remote session ${rs.id} (${idle ? 'idle' : hidden ? 'hidden' : 'max time'})`); this.end(rs.id); }
    }
    for (const [k, until] of this.grants) if (until < now) this.grants.delete(k);
    for (const [k, until] of this.quarantine) if (until < now) this.quarantine.delete(k);
    // Library changed: nodes refresh their copy.
    if (this.conns.size) {
      const v = await this.libraryVersion().catch(() => null);
      if (v != null && this.libVersion != null && v !== this.libVersion) for (const c of this.conns.values()) this.send(c, { t: 'lib', version: v });
      this.libVersion = v;
    }
  }

  shutdown() {
    for (const c of this.conns.values()) this.send(c, { t: 'bye', end: true });
  }

  // ---------------------------------------------------------------- files and library for nodes
  /** Caps to judge a node by when its tunnel isn't up (HTTP /node-api calls). */
  viewOf(rec) { return this.conns.get(rec.id) || { id: rec.id, caps: rec.caps || {} }; }

  async nodeLibrary(c) {
    const games = await library.list();
    return { version: await this.libraryVersion(), games: games.filter(g => !g.missing && this.gameAllowed(c, g)).map(trimEntry) };
  }

  grant(nodeId, name) { this.grants.set(`${nodeId}\n${name}`, Date.now() + GRANT_MS); }

  /** The file a node asks for, if it may have it: { dir, file } or null. Keys/firmware never qualify. */
  async resolveFile(c, kind, name) {
    const plain = n => !!n && n === path.basename(n) && !n.startsWith('.') && !/[\u0000-\u001f]/.test(n);
    const allowed = () => library.list().then(gs => gs.filter(g => !g.missing && this.gameAllowed(c, g)));
    let dir;
    if (kind === 'apk') {
      if (!plain(name) || !(await allowed()).some(g => g.apk === name)) return null;
      dir = config.apkDir;
    } else if (kind === 'rom') {
      const parts = name.split('/');
      if (parts.length !== 2 || !Object.hasOwn(SYSTEMS, parts[0]) || !plain(parts[1]) || !(await allowed()).some(g => g.rom === name)) return null;
      dir = config.romDir;
    } else if (kind === 'file') {
      if (!plain(name)) return null;
      const granted = (this.grants.get(`${c.id}\n${name}`) || 0) > Date.now();
      if (!granted && !(await allowed()).some(g => g.file === name)) return null;
      dir = config.fileDir;
    } else if (kind === 'emu') {
      if (!plain(name) || !Object.values(SYSTEMS).some(s => s.apk?.local?.test(name))) return null;
      dir = config.apkDir;
    } else {
      return null;
    }
    // No symlinks out of the folder.
    const [root, real] = await Promise.all([fs.realpath(dir), fs.realpath(path.join(dir, name)).catch(() => null)]);
    if (!real || !real.startsWith(root + path.sep)) return null;
    const st = await fs.stat(real).catch(() => null);
    return st?.isFile() ? { path: real, size: st.size, mtimeMs: st.mtimeMs } : null;
  }

  async hashOf(f) {
    const hit = this.hashes.get(f.path);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.sha256;
    const h = crypto.createHash('sha256');
    for await (const chunk of createReadStream(f.path)) h.update(chunk);
    const sha256 = h.digest('hex');
    this.hashes.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, sha256 });
    if (this.hashes.size > 2000) this.hashes.delete(this.hashes.keys().next().value);
    return sha256;
  }

  /** /node-api: node-token routes (library and game files). */
  nodeApi() {
    const r = express.Router();
    r.use(this.requireNode());
    r.get('/lib', async (req, res) => {
      try {
        const body = await gzip(JSON.stringify(await this.nodeLibrary(this.viewOf(req.nodeRec))));
        if (body.length > 4 * MiB) return res.status(507).json({ error: 'library too large' });
        res.set({ 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' }).type('json').send(body);
      } catch (e) { res.status(500).json({ error: cleanText(e.message, 200) }); }
    });
    // /files/<kind>/<encodeURIComponent(name)>[/meta]; rom names are "<system>/<file>" (%2F).
    r.get(/^\/files\/(apk|rom|file|emu)\/([^/]+)(\/meta)?$/, async (req, res) => {
      const rec = req.nodeRec;
      const kind = req.params[0], name = req.params[1], meta = !!req.params[2];
      const f = await this.resolveFile(this.viewOf(rec), kind, name).catch(() => null);
      if (!f) { log(`nodes: ${rec.id}: refused file ${kind}/${cleanText(name, 80)}`); return res.status(404).json({ error: 'not found' }); }
      const hit = this.hashes.get(f.path);
      if (meta && hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return res.set('Cache-Control', 'no-store').json({ size: f.size, sha256: hit.sha256 });
      // Downloads and uncached hashes (a full read of the file) share the per-node limit.
      const n = this.transfers.get(rec.id) || 0;
      if (n >= TRANSFERS_PER_NODE) return res.status(429).json({ error: 'too many downloads at once' });
      this.transfers.set(rec.id, n + 1);
      let set = this.fileRes.get(rec.id);
      if (!set) this.fileRes.set(rec.id, set = new Set());
      set.add(res);
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        this.transfers.set(rec.id, Math.max(0, (this.transfers.get(rec.id) || 1) - 1));
        this.fileRes.get(rec.id)?.delete(res);
      };
      res.on('close', release);
      if (meta) {
        // Hashing a big file takes a while: same heartbeat as long() (leading spaces, then JSON).
        res.status(200).type('json').set('Cache-Control', 'no-store');
        res.flushHeaders();
        const beat = setInterval(() => res.write(' '), 1000);
        let body;
        try { body = { size: f.size, sha256: await this.hashOf(f) }; } catch (e) { body = { error: 'could not read the file' }; }
        clearInterval(beat);
        release();
        return res.end(JSON.stringify(body));
      }
      log(`nodes: ${rec.id}: sending ${kind}/${path.basename(f.path)}${req.headers.range ? ` (${String(req.headers.range).slice(0, 40)})` : ''}`);
      res.sendFile(f.path, { dotfiles: 'allow', acceptRanges: true, cacheControl: false, headers: { 'Content-Type': 'application/octet-stream' } }, err => {
        release();
        if (err && !res.headersSent) res.status(err.status || 500).end();
      });
    });
    r.use((req, res) => res.status(404).json({ error: 'not found' }));
    return r;
  }

  // ---------------------------------------------------------------- install bundle
  /** The code a node builds: Dockerfile, package files, server/, public/, docker-compose.node.yml. */
  async bundle() {
    const want = ['Dockerfile', 'package.json', 'package-lock.json', 'docker-compose.node.yml', 'server', 'public'];
    const have = [];
    for (const n of want) if (await fs.stat(path.join(APP_DIR, n)).catch(() => null)) have.push(n);
    // Fingerprint: every file's size and mtime.
    const stamp = crypto.createHash('sha1');
    const walk = async p => {
      const st = await fs.stat(p).catch(() => null);
      if (!st) return;
      if (st.isDirectory()) { for (const e of (await fs.readdir(p)).sort()) await walk(path.join(p, e)); } else stamp.update(`${p}\n${st.size}\n${st.mtimeMs}\n`);
    };
    for (const n of have) await walk(path.join(APP_DIR, n));
    const key = stamp.digest('hex');
    if (this.bundleCache?.key === key) return this.bundleCache;
    const tar = await new Promise((ok, no) => execFile('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '--exclude=node_modules', '-C', APP_DIR, '-cf', '-', ...have], { encoding: 'buffer', maxBuffer: 64 * MiB }, (e, out) => (e ? no(e) : ok(out))));
    const body = await gzip(tar, { level: 9 });   // (not gzipSync: it would stall every stream)
    this.bundleCache = { key, body, sha256: crypto.createHash('sha256').update(body).digest('hex') };
    return this.bundleCache;
  }

  /** /node/*: the installer and compose file (public), the code bundle (node token). */
  installRouter() {
    const r = express.Router();
    const serve = (file, type) => async (req, res) => {
      const body = await fs.readFile(path.join(APP_DIR, file)).catch(() => null);
      if (!body) return res.status(404).type('text').send('not available on this server\n');
      res.type(type).set('Cache-Control', 'no-cache').send(body);
    };
    r.get('/install.sh', serve('scripts/node-install.sh', 'text/x-shellscript'));
    // Windows / macOS: a small Ubuntu VM (Multipass) running the Linux node. The cloud-init is served
    // with its @@...@@ placeholders; the installers fill in the hub and token on the host itself.
    r.get('/install.ps1', serve('scripts/node-install.ps1', 'text/plain; charset=utf-8'));
    r.get('/install-mac.sh', serve('scripts/node-install-mac.sh', 'text/x-shellscript'));
    r.get('/cloud-init.yaml', serve('scripts/vm/cloud-init.yaml', 'text/plain; charset=utf-8'));
    r.get('/docker-compose.node.yml', serve('docker-compose.node.yml', 'text/yaml'));
    r.get('/bundle.tgz', this.requireNode(), async (req, res) => {
      try {
        const b = await this.bundle();
        res.set({ 'x-rose-bundle-sha256': b.sha256, 'Cache-Control': 'no-store' }).type('application/gzip').send(b.body);
      } catch (e) { log(`nodes: bundle failed: ${e.message}`); res.status(500).json({ error: 'could not build the bundle' }); }
    });
    return r;
  }

  // ---------------------------------------------------------------- owner API (/api/nodes, upload password)
  view(rec) {
    const c = this.conns.get(rec.id);
    const now = Date.now();
    return {
      id: rec.id, name: rec.name, disabled: !!rec.disabled, cap: rec.cap || 0, createdAt: rec.createdAt, lastSeen: c ? now : rec.lastSeen || 0,
      online: !!c, specs: c?.specs || rec.lastSpecs || null, caps: c?.caps || rec.caps || null, version: c?.version || rec.version || '',
      bundle: c?.bundle || '', outdated: !!(c && this.bundleCache && c.bundle !== this.bundleCache.sha256),
      max: c?.max || 0, limit: c ? this.limit(c) : 0, active: this.nodeSessions.get(rec.id)?.sessions.size || 0,
      pooled: c?.pooled || 0, booting: c?.booting || 0, freeMb: c?.freeMb || 0, load1: c?.load1 || 0, rtt: c?.rtt ?? null,
      eligible: c ? this.eligible(c) : false, degraded: !!(c && c.degradedUntil > now),
      quarantinedUntil: (this.quarantine.get(rec.id) || 0) > now ? this.quarantine.get(rec.id) : 0,
    };
  }

  adminRouter(requireUpload) {
    const r = express.Router();
    r.use(requireUpload);
    // Pasted into other people's shells: only a plain http(s) origin (+ path) is ever used.
    const hubUrl = req => {
      const u = config.publicUrl || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
      return /^https?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?(\/[A-Za-z0-9._~\-\/]*)?$/.test(u) ? u.replace(/\/+$/, '') : 'https://YOUR-HUB-ADDRESS';
    };
    r.get('/', async (req, res) => {
      await this.bundle().catch(() => null);   // for the outdated flag
      res.set('Cache-Control', 'no-store').json({ nodes: [...this.recs.values()].map(rec => this.view(rec)), scheduler: this.settings.scheduler,
        schedulers: SCHEDULERS, hubUrl: hubUrl(req) });
    });
    r.post('/', (req, res) => {
      const t = this.createToken(req.body?.name);
      const hub = hubUrl(req);
      res.json({ ...t, hubUrl: hub, ...installCommands(hub, t.token) });
    });
    r.put('/settings', (req, res) => {
      const s = req.body?.scheduler;
      if (!SCHEDULERS.includes(s)) return res.status(400).json({ error: `scheduler must be one of ${SCHEDULERS.join(', ')}` });
      this.settings.scheduler = s;
      this.save();
      log(`nodes: placement set to ${s}`);
      res.json({ scheduler: s });
    });
    r.patch('/:id', (req, res) => {
      const rec = this.recs.get(req.params.id);
      if (!rec) return res.status(404).json({ error: 'no such host' });
      const b = req.body || {};
      if (b.name !== undefined) rec.name = cleanName(b.name) || rec.name;
      if (b.cap !== undefined) rec.cap = int(b.cap, 0, 64);
      if (b.disabled !== undefined) {
        rec.disabled = b.disabled === true;
        log(`nodes: "${rec.name}" (${rec.id}) ${rec.disabled ? 'disabled' : 'enabled'}`);
      }
      this.save();
      res.json(this.view(rec));
    });
    r.post('/:id/end-sessions', (req, res) => {
      if (!this.recs.has(req.params.id)) return res.status(404).json({ error: 'no such host' });
      const n = this.nodeSessions.get(req.params.id)?.sessions.size || 0;
      this.endNodeSessions(req.params.id);
      res.json({ ended: n });
    });
    r.delete('/:id', (req, res) => {
      if (!this.revoke(req.params.id)) return res.status(404).json({ error: 'no such host' });
      res.json({ ok: true });
    });
    return r;
  }
}

/** The one-liners a host runs, per OS (the same model as Linux: the token is in the command). */
export const installCommands = (hub, token) => ({
  // The token goes in bash's environment, not its arguments (ps shows those to every user on the machine).
  install: `curl -fsSL ${hub}/node/install.sh | ROSE_NODE_TOKEN=${token} bash -s -- --hub ${hub}`,
  // (TLS 1.2 first: Windows PowerShell 5.1 on older Windows 10 can't reach a TLS 1.2-only hub without it.)
  installWindows: `[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; $env:ROSE_HUB_URL='${hub}'; $env:ROSE_NODE_TOKEN='${token}'; irm ${hub}/node/install.ps1 | iex`,
  installMac: `curl -fsSL ${hub}/node/install-mac.sh | ROSE_NODE_TOKEN=${token} bash -s -- --hub ${hub}`,
});

const cleanName = n => cleanText(n, 40).replace(/[^\w .\-']/g, '').trim();
const offline = name => ({ error: `The host ${name || ''} went offline. Try again.`.replace(/\s+/g, ' '), status: 502 });
