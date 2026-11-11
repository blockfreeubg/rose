// Rose node, node side: the outbound tunnel to the hub (nodes.js there; protocol in tunnel.js).
//
// Node mode = ROSE_HUB_URL + ROSE_NODE_TOKEN. This process runs its own SessionManager on this
// machine and serves its API on 127.0.0.1 only (index.js). The agent:
//   - dials wss://<hub>/node/tunnel (bearer token, no Origin), with backoff, and says hello
//     (specs, capacity, the sessions it still runs);
//   - replays the hub's requests ({t:'req'}) against the local API with a per-boot token, so the
//     node runs exactly the code a hub runs for its own sessions (long() heartbeats become res.beat);
//   - streams upload bodies (REQ_BODY frames) into a local chunked upload, then hands it to the route;
//   - bridges each relayed browser stream (ws.open/chan) to a local /ws, so hidden throttling, audio
//     and pads work unchanged, with the same backpressure rules as a local session;
//   - reports session changes (sess/gone, only for sessions the hub claimed) and a heartbeat;
//   - loads the hub's library (/node-api/lib) into library.js; game files come through assets.js.
// The node never learns players' addresses, the hub's passwords or other nodes: it only gets what
// the hub puts in these messages.
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { config } from './config.js';
import { detect } from './specs.js';
import * as library from './library.js';
import { PROTO, T, LIMITS, frame, parseFrame, sanitizeInput, sanitizeDownText, cleanText } from './tunnel.js';

const log = (...a) => console.log(new Date().toISOString(), 'node:', ...a);
const MiB = 1024 * 1024;
const RID = /^[0-9a-f]{10}$/;
const TOKEN = /^rn_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;
const CLAIM_MS = 30_000;            // a session the hub never claimed (its create reply was lost) ends
const HB_MS = 10_000;
const PING_DEAD_MS = 30_000;        // no ping from the hub this long: the tunnel is dead
const BEAT_MS = 5_000;              // res.beat at most this often
const SESS_MIN_MS = 600;            // {t:'sess'} at most ~2/s per session
const TUNNEL_VIDEO_MAX = 4 * MiB;   // tunnel backed up: drop delta frames, ask for a keyframe
const TUNNEL_AUDIO_MAX = 1 * MiB;
const TUNNEL_HARD_MAX = 16 * MiB;   // only codec configs pass beyond this
const VIEWERS_PER_SESSION = 6;
const UP_QUEUE_MAX = 200;           // browser input held until the local /ws is open
const LOCAL_REPLY_MAX = 1 * MiB;
const LOCAL_OP_MAX_MS = 50 * 60_000;
const VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || ''); } catch { return ''; }
})();
const BUNDLE = /^[0-9a-f]{64}$/.test(process.env.ROSE_BUNDLE_SHA256 || '') ? process.env.ROSE_BUNDLE_SHA256 : '';

/** A plain http:// hub is fine on a private network (or the host itself); anywhere else it needs ROSE_HUB_INSECURE=1. */
function privateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || !h.includes('.') && !net.isIP(h)) return true;   // single-label names: docker/LAN
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return false;
}

/**
 * Can this machine be a node at all? Logs every problem; [] = fine. Checked before anything starts.
 */
export function preflight() {
  const s = detect();
  const problems = [];
  let hub = null;
  try { hub = new URL(config.hubUrl); } catch {}
  if (!hub || !/^https?:$/.test(hub.protocol)) problems.push(`ROSE_HUB_URL "${config.hubUrl}" is not an http(s) address`);
  else if (hub.protocol === 'http:' && !config.hubInsecure && !privateHost(hub.hostname)) {
    problems.push(`the hub ${hub.host} is plain http:// on a public address: use its https:// address (or set ROSE_HUB_INSECURE=1)`);
  }
  if (!TOKEN.test(config.nodeToken)) problems.push('ROSE_NODE_TOKEN is missing or malformed (it looks like rn_xxxxxxxx_...; ask the hub owner)');
  // arm64 (e.g. the Apple Silicon VM from node-install-mac.sh): ARM games run natively; no Switch (x86_64 emulator).
  if (s.arch !== 'x64' && s.arch !== 'arm64') problems.push(`this machine is ${s.arch}: Rose nodes need x86_64 (amd64) or arm64`);
  if (!s.binder) {
    problems.push('the kernel has no binder (Android needs it): run "sudo modprobe binder_linux devices=binder,hwbinder,vndbinder" '
      + '(or use a kernel with binderfs); WSL2 and many VPS kernels need a custom kernel or module');
  }
  if (!(config.maxSessions >= 1)) {
    problems.push(`this machine is too small for even one session (${s.threads} threads, ${Math.round(s.ramMb / 1024)} GB RAM; `
      + 'about 2.5 GB RAM and 2 threads per session plus 2 GB for the system). Set MAX_SESSIONS to override');
  }
  for (const p of problems) log(`cannot start: ${p}`);
  return problems;
}

export class NodeAgent {
  /** manager: the local SessionManager; port/localToken: the local API (127.0.0.1) and its per-boot token. */
  constructor({ manager, port, localToken }) {
    this.manager = manager;
    this.port = port;
    this.localToken = localToken;
    this.specs = detect();
    // The node's own container has no /dev/dri; its sessions get the host's (GPU_MODE=host, set by
    // the installer when the host has a render node).
    this.specs.gpu = this.specs.gpu || config.gpuMode === 'host';
    this.nodeBoot = crypto.randomBytes(12).toString('hex');
    this.hubBoot = null;              // the hub's boot id when we last talked: a new one = it restarted
    this.name = '';
    this.ws = null;
    this.welcomed = false;
    this.connectedAt = 0;
    this.lastPing = 0;
    this.backoff = 1;
    this.retryTimer = null;
    this.stopping = false;
    this.listed = [];                 // the sessions named in our last hello
    this.reqs = new Map();            // request id -> { op, aborted, lastBeat, up? }
    this.chans = new Map();           // stream chan -> { rid, local, pending, needsKey, keyAt }
    this.claimed = new Set();         // sessions the hub knows about (only these get sess/gone)
    this.claimTimers = new Map();
    this.reported = new Map();        // rid -> { json, at }
    const maxGrowMb = Math.max(0, this.specs.ramMb - config.hostReserveMb - 1024);
    this.caps = { switch: this.specs.arch === 'x64' && this.specs.uhid && maxGrowMb >= config.switchMemoryMb, uploads: config.nodeAllowUploads, uhid: this.specs.uhid, maxGrowMb };
    library.useRemote(() => this.fetchLibrary());
  }

  start() {
    const s = this.specs;
    log(`${s.cpuModel}, ${s.threads} threads, ${Math.round(s.ramMb / 1024)} GB RAM, GPU ${s.gpu ? 'yes' : 'no'}, uhid ${s.uhid ? 'yes' : 'no'}${s.wsl ? ', WSL' : ''}; `
      + `up to ${config.maxSessions} session(s), uploads ${config.nodeAllowUploads ? 'on' : 'off'}; hub ${config.hubUrl}`);
    this.manager.on('change', sess => this.onChange(sess));
    setInterval(() => this.pollSessions(), 1000).unref();
    setInterval(() => this.heartbeat(), HB_MS).unref();
    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastPing > PING_DEAD_MS) {
        log('no ping from the hub for 30 s: reconnecting');
        this.ws.terminate();
      }
    }, 5000).unref();
    this.connect();
  }

  // ---------------------------------------------------------------- tunnel
  connect() {
    this.retryTimer = null;
    if (this.stopping) return;
    const url = `${config.hubUrl.replace(/^http(s?):/i, 'ws$1:')}/node/tunnel`;
    let refused = 0;
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.nodeToken}` },   // never in the URL; no Origin header
      perMessageDeflate: false, maxPayload: 4 * LIMITS.TUNNEL_MAX_PAYLOAD, handshakeTimeout: 15_000, followRedirects: false,
    });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => {
      this.connectedAt = Date.now();
      this.lastPing = Date.now();
      this.listed = [...this.manager.sessions.keys()].filter(id => RID.test(id)).slice(0, 64);
      this.send({
        t: 'hello', proto: PROTO, version: VERSION, bundle: BUNDLE, nodeBoot: this.nodeBoot, specs: this.specs, caps: this.caps,
        max: config.maxSessions, pooled: this.manager.pool.length, active: this.manager.sessions.size, sessions: this.listed,
      });
    });
    ws.on('ping', () => { this.lastPing = Date.now(); });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      try {
        if (isBinary) this.onBinary(data);
        else this.onText(data.toString('utf8'));
      } catch (e) {
        log(`bad message from the hub: ${e.message}`);
      }
    });
    ws.on('error', e => {
      const m = /Unexpected server response: (\d+)/.exec(e.message);
      if (m) refused = Number(m[1]);
      else if (!this.connectedAt || this.ws !== ws) log(`could not reach the hub: ${e.code || e.message}`);
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.onClosed(code, cleanText(reason?.toString('utf8'), 100), refused);
    });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onClosed(code, reason, refused) {
    const wasUp = this.welcomed;
    const upFor = this.connectedAt ? Date.now() - this.connectedAt : 0;
    this.ws = null;
    this.welcomed = false;
    this.connectedAt = 0;
    // Everything that ran through the tunnel is gone: requests get no reply, streams close.
    for (const r of this.reqs.values()) { r.aborted = true; this.dropUpload(r); }
    this.reqs.clear();
    for (const [chan, ch] of this.chans) { this.chans.delete(chan); closeLocal(ch); }
    if (this.stopping) return;
    if (wasUp) log(`disconnected from the hub (${code}${reason ? ` ${reason}` : ''})`);
    let delay;
    if (refused === 401 || code === 4401) {
      log('token revoked/disabled by the hub owner: ask them for a new one (retrying every 10 min)');
      delay = 600;
    } else if (refused === 403) {
      log('token revoked/disabled by the hub owner (retrying every 10 min)');
      delay = 600;
    } else if (refused === 429) {
      log('the hub locked this address out after too many wrong tokens (retrying in 10 min)');
      delay = 600;
    } else if (code === 4426) {
      log('the hub speaks a newer protocol: update your node (rerun the installer). Retrying every 30 min');
      delay = 1800;
    } else {
      if (refused === 503) log('the hub has no room for this node right now (too many nodes, or it is held back for misbehaving)');
      else if (code === 4409) log('another connection with this token replaced this one: is the same token used on two machines?');
      else if (code === 4400) log(`the hub closed the tunnel: ${reason || 'protocol error'}`);
      else if (code === 1001 && wasUp) log('the hub is restarting');
      if (upFor >= 60_000) this.backoff = 1;
      delay = this.backoff * (0.7 + Math.random() * 0.6);
      if (code === 4409) delay = Math.max(delay, 30);
      this.backoff = Math.min(60, this.backoff * 2);
    }
    log(`reconnecting in ${delay >= 120 ? `${Math.round(delay / 60)} min` : `${delay.toFixed(1)} s`}`);
    this.retryTimer = setTimeout(() => this.connect(), delay * 1000);
  }

  onText(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'welcome': return this.onWelcome(m);
      case 'req': return this.onReq(m);
      case 'req.end': return this.onReqEnd(m.id);
      case 'req.abort': {
        const r = this.reqs.get(m.id);
        if (!r) return;
        r.aborted = true;
        this.reqs.delete(m.id);
        this.dropUpload(r);
        return;
      }
      case 'ws.open': return this.openStream(m.chan, m.rid);
      case 'ws.close': {
        const ch = this.chans.get(m.chan);
        if (!ch) return;
        this.chans.delete(m.chan);
        closeLocal(ch);
        return;
      }
      case 'end':
        if (typeof m.rid === 'string' && this.manager.get(m.rid)) { log(`the hub ended session ${m.rid}`); this.manager.end(m.rid).catch(() => {}); }
        return;
      case 'claim':
        if (typeof m.rid === 'string' && this.manager.get(m.rid)) {
          this.claimed.add(m.rid);
          clearTimeout(this.claimTimers.get(m.rid));
          this.claimTimers.delete(m.rid);
          this.report(m.rid, true);
        }
        return;
      case 'lib':
        if (m.version !== library.remoteVersion()) library.refreshRemote();
        return;
      case 'bye':
        log(`the hub is shutting down${m.end ? ': ending its sessions' : ''}`);
        if (m.end) this.endActive();
        return;
      default: return;   // reply, and anything newer than this node
    }
  }

  onWelcome(m) {
    const restarted = this.hubBoot && m.hubBoot !== this.hubBoot;
    this.hubBoot = typeof m.hubBoot === 'string' ? m.hubBoot : null;
    this.name = cleanText(m.name, 40) || 'this node';
    this.welcomed = true;
    if (restarted) {
      // A restarted hub knows none of our sessions (and has told their players nothing): end them.
      log('the hub restarted: ending the sessions it started before');
      this.endActive();
    } else {
      // Sessions from our hello that the hub still has (it sent {t:'end'} before this for the rest).
      for (const rid of this.listed) if (this.manager.get(rid)) { this.claimed.add(rid); this.report(rid, true); }
    }
    log(`connected to hub as ${this.name} (max ${config.maxSessions})`);
    this.heartbeat();
    if (m.libraryVersion !== library.remoteVersion()) library.refreshRemote();
  }

  heartbeat() {
    if (!this.welcomed) return;
    const mgr = this.manager;
    this.send({ t: 'hb', active: mgr.sessions.size, pooled: mgr.pool.length, booting: mgr.booting, max: config.maxSessions,
      freeMb: Math.round(os.freemem() / MiB), load1: Math.round(os.loadavg()[0] * 100) / 100 });
  }

  endActive() {
    for (const id of [...this.manager.sessions.keys()]) this.manager.end(id).catch(() => {});
  }

  // ---------------------------------------------------------------- session state
  onChange(s) {
    if (!s?.id) return;
    if (!this.manager.sessions.has(s.id)) return this.gone(s.id);
    this.report(s.id);
  }

  gone(rid) {
    clearTimeout(this.claimTimers.get(rid));
    this.claimTimers.delete(rid);
    this.reported.delete(rid);
    for (const [chan, ch] of this.chans) if (ch.rid === rid) { this.chans.delete(chan); this.send({ t: 'ws.close', chan, code: 1000, reason: 'session ended' }); closeLocal(ch); }
    if (!this.claimed.delete(rid)) return;
    if (this.welcomed) this.send({ t: 'gone', rid });
  }

  /** Tell the hub a claimed session's info changed (at most ~2/s; force: even if unchanged). */
  report(rid, force = false) {
    if (!this.welcomed || !this.claimed.has(rid)) return;
    const s = this.manager.get(rid);
    if (!s) return;
    const info = s.info();
    const json = JSON.stringify(info);
    const last = this.reported.get(rid);
    if (!force && last?.json === json) return;
    if (last && Date.now() - last.at < SESS_MIN_MS) return;   // the 1 s poll sends it shortly
    this.reported.set(rid, { json, at: Date.now() });
    this.send({ t: 'sess', rid, info: fitInfo(info) });
  }

  pollSessions() {
    for (const rid of [...this.claimed]) {
      if (!this.manager.sessions.has(rid)) this.gone(rid);
      else this.report(rid);
    }
  }

  // ---------------------------------------------------------------- requests (hub -> local API)
  onReq(m) {
    const id = m.id;
    if (!Number.isInteger(id) || id < 1 || this.reqs.has(id)) return;
    const r = { id, op: m.op, aborted: false, lastBeat: 0 };
    this.reqs.set(id, r);
    const rid = typeof m.rid === 'string' && RID.test(m.rid) ? m.rid : null;
    const json = m.json && typeof m.json === 'object' && !Array.isArray(m.json) ? m.json : {};
    const needSession = () => {
      if (rid && this.manager.get(rid)) return true;
      this.reply(r, 404, { error: 'session not found', status: 404 });
      return false;
    };
    const run = (method, p, body) => this.local(method, p, body, () => this.beat(r)).then(x => this.reply(r, x.status, x.body));
    switch (m.op) {
      case 'create':
        return this.local('POST', '/api/sessions', {}, () => this.beat(r)).then(x => {
          const sid = x.body?.id;
          if (!x.body?.error && typeof sid === 'string' && RID.test(sid)) this.expectClaim(sid);
          this.reply(r, x.status, x.body);
        });
      case 'info': return needSession() && run('GET', `/api/sessions/${rid}`);
      case 'play': case 'launch': case 'push':
        return needSession() && run('POST', `/api/sessions/${rid}/${m.op}`, json);
      case 'end':
        if (!rid || !this.manager.get(rid)) return this.reply(r, 200, { ok: true });
        return run('DELETE', `/api/sessions/${rid}`);
      case 'apk': case 'file':
        return this.startUpload(r, rid, m.upload);
      default:
        return this.reply(r, 400, { error: 'unknown request', status: 400 });
    }
  }

  reply(r, status, body) {
    if (this.reqs.get(r.id) !== r) return;   // aborted, or the tunnel dropped
    this.reqs.delete(r.id);
    this.dropUpload(r);
    let b = body && typeof body === 'object' && !Array.isArray(body) ? body : { error: 'bad reply from the local server', status: 502 };
    if (b.error && b.status == null) b = { ...b, status: status >= 400 ? status : 500 };
    if (b.apps && JSON.stringify(b).length > LIMITS.RES_BODY_MAX) b = { ...b, apps: b.apps.slice(0, 50) };
    if (JSON.stringify(b).length > LIMITS.RES_BODY_MAX) b = { error: 'the reply was too large', status: 502 };
    this.send({ t: 'res', id: r.id, status, body: b });
  }

  beat(r) {
    const now = Date.now();
    if (r.aborted || now - r.lastBeat < BEAT_MS) return;
    r.lastBeat = now;
    this.send({ t: 'res.beat', id: r.id });
  }

  /** A session we just created: the hub claims it right after our reply, or it is ended. */
  expectClaim(rid) {
    clearTimeout(this.claimTimers.get(rid));
    this.claimTimers.set(rid, setTimeout(() => {
      this.claimTimers.delete(rid);
      if (!this.claimed.has(rid) && this.manager.get(rid)) { log(`session ${rid} was never claimed by the hub: ending it`); this.manager.end(rid).catch(() => {}); }
    }, CLAIM_MS));
  }

  /**
   * Call the local API (127.0.0.1, with the per-boot token). long() routes answer 200 at once and
   * then spaces until the JSON: each space calls onBeat. Resolves { status, body }; never rejects.
   */
  local(method, p, json, onBeat) {
    return new Promise(resolve => {
      const data = json ? JSON.stringify(json) : null;
      const req = http.request({
        host: '127.0.0.1', port: this.port, method, path: p,
        headers: { 'x-access-token': this.localToken, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      }, res => {
        let buf = '', size = 0;
        res.setEncoding('utf8');
        res.on('data', d => {
          size += d.length;
          if (size > LOCAL_REPLY_MAX) { req.destroy(); return; }
          if (!d.trim()) onBeat?.();
          buf += d;
        });
        res.on('end', () => {
          clearTimeout(t);
          let body;
          try { body = JSON.parse(buf.trim()); } catch { body = { error: 'bad reply from the local server', status: 502 }; }
          resolve({ status: res.statusCode, body });
        });
        res.on('error', () => {});
      });
      const t = setTimeout(() => req.destroy(new Error('timed out')), LOCAL_OP_MAX_MS);
      req.on('error', e => { clearTimeout(t); resolve({ status: 502, body: { error: `the host could not run that (${e.message})`, status: 502 } }); });
      req.end(data || undefined);
    });
  }

  // ---------------------------------------------------------------- uploads (REQ_BODY frames)
  startUpload(r, rid, up) {
    if (!config.nodeAllowUploads) return this.reply(r, 403, { error: 'This host does not take uploads.', status: 403 });
    if (!rid || !this.manager.get(rid)) return this.reply(r, 404, { error: 'session not found', status: 404 });
    const size = up?.size;
    const name = typeof up?.name === 'string' ? path.basename(up.name).slice(0, 200) : '';
    if (!Number.isSafeInteger(size) || size <= 0 || size > LIMITS.UPLOAD_MAX || !name) return this.reply(r, 400, { error: 'bad upload', status: 400 });
    const uploadId = crypto.randomBytes(12).toString('hex');
    const dir = path.join(os.tmpdir(), 'rose-chunks');   // where chunked.adopt() looks for it
    const file = path.join(dir, uploadId);
    const u = { rid, size, name, uploadId, file, fh: null, received: 0, got: 0, acked: 0, posted: false, failed: false };
    r.up = u;
    u.chain = (async () => {
      const st = await fs.statfs(os.tmpdir()).catch(() => null);
      if (st && st.bavail * st.bsize - size < 1024 * MiB) throw Object.assign(new Error('This host is short on disk space for that file.'), { status: 507 });
      await fs.mkdir(dir, { recursive: true });
      u.fh = await fs.open(file, 'w', 0o600);
    })();
    u.chain.catch(e => this.failUpload(r, e));
  }

  onUploadChunk(id, payload) {
    const r = this.reqs.get(id);
    const u = r?.up;
    if (!u || u.failed || u.ended) return;
    u.received += payload.length;
    if (u.received > u.size) return this.failUpload(r, Object.assign(new Error('the upload is larger than it said'), { status: 413 }));
    const chunk = Buffer.from(payload);   // the frame buffer may be reused
    u.chain = u.chain.then(async () => {
      if (u.failed) return;
      await u.fh.write(chunk);
      u.got += chunk.length;
      if (u.got - u.acked >= LIMITS.ACK_EVERY || u.got === u.size) { u.acked = u.got; this.send({ t: 'ack', id, got: u.got }); }
    });
    u.chain.catch(e => this.failUpload(r, e));
  }

  onReqEnd(id) {
    const r = this.reqs.get(id);
    const u = r?.up;
    if (!u || u.failed || u.ended) return;
    u.ended = true;
    u.chain.then(async () => {
      await u.fh?.close();
      u.fh = null;
      if (u.got !== u.size) throw Object.assign(new Error('the upload was cut off'), { status: 400 });
      if (this.reqs.get(id) !== r) return;
      // multer skips this JSON body; chunked.adopt() picks the file up as req.file, as for any chunked upload.
      u.posted = true;
      const x = await this.local('POST', `/api/sessions/${u.rid}/${r.op}`, { uploadId: u.uploadId, uploadName: u.name }, () => this.beat(r));
      this.reply(r, x.status, x.body);
    }).catch(e => this.failUpload(r, e));
  }

  failUpload(r, e) {
    const u = r.up;
    if (!u || u.failed) return;
    u.failed = true;
    this.reply(r, e.status || 500, { error: cleanText(e.message, 200) || 'upload failed', status: e.status || 500 });
    this.dropUpload(r);
  }

  /** Remove an upload's temp file unless the local route already owns it. */
  dropUpload(r) {
    const u = r.up;
    if (!u || u.posted || u.dropped) return;
    u.dropped = true;
    u.failed = true;
    u.chain.catch(() => {}).then(async () => {
      await u.fh?.close().catch(() => {});
      u.fh = null;
      await fs.rm(u.file, { force: true });
    });
  }

  // ---------------------------------------------------------------- streams
  onBinary(buf) {
    const f = parseFrame(buf);
    if (!f) return;
    if (f.type === T.REQ_BODY) return this.onUploadChunk(f.chan, f.payload);
    if (f.type !== T.WS_UP_TXT) return;
    const ch = this.chans.get(f.chan);
    if (!ch || f.payload.length > 64 * 1024) return;
    let m;
    try { m = sanitizeInput(JSON.parse(f.payload.toString('utf8'))); } catch { return; }
    if (!m) return;
    const text = JSON.stringify(m);
    if (ch.pending) { if (ch.pending.length < UP_QUEUE_MAX) ch.pending.push(text); return; }
    if (ch.local.readyState === WebSocket.OPEN) ch.local.send(text);
  }

  /** A browser started watching session `rid`: bridge it to a local /ws on channel `chan`. */
  openStream(chan, rid) {
    if (!Number.isInteger(chan) || chan < 1 || chan > 0xffffffff || this.chans.has(chan)) return;
    const refuse = (code, reason) => this.send({ t: 'ws.close', chan, code, reason });
    const s = typeof rid === 'string' && RID.test(rid) ? this.manager.get(rid) : null;
    if (!s?.scrcpy) return refuse(4004, 'no such session');
    const mine = [...this.chans.values()].filter(c => c.rid === rid).length;
    if (mine >= VIEWERS_PER_SESSION || this.chans.size >= Math.max(4, 4 * config.maxSessions)) return refuse(4429, 'too many viewers');
    const local = new WebSocket(`ws://127.0.0.1:${this.port}/ws?session=${rid}&token=${encodeURIComponent(this.localToken)}`, { perMessageDeflate: false });
    local.binaryType = 'nodebuffer';
    const ch = { chan, rid, local, pending: [], needsKey: false, keyAt: 0 };
    this.chans.set(chan, ch);
    local.on('open', () => { for (const t of ch.pending || []) local.send(t); ch.pending = null; });
    local.on('message', (data, isBinary) => this.down(ch, data, isBinary));
    local.on('close', (code, reason) => {
      if (this.chans.get(chan) !== ch) return;   // the hub closed it first
      this.chans.delete(chan);
      this.send({ t: 'ws.close', chan, code: code === 1000 ? 1000 : code || 1011, reason: cleanText(reason?.toString('utf8'), 100) });
    });
    local.on('error', () => {});
  }

  /** Local session -> browser, through the tunnel. Same drop rules as a local session's viewers. */
  down(ch, data, isBinary) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.chans.get(ch.chan) !== ch) return;
    if (!isBinary) {
      let m = null;
      try { m = sanitizeDownText(JSON.parse(data.toString('utf8'))); } catch {}
      if (m) ws.send(frame(T.WS_DOWN_TXT, ch.chan, JSON.stringify(m)));
      return;
    }
    const kind = data[0];
    if (data.length < 1 || kind > 4) return;
    const buffered = ws.bufferedAmount;
    if (buffered > TUNNEL_HARD_MAX && kind !== 0 && kind !== 3) { ch.needsKey = true; return; }
    if (kind === 2) {
      if (buffered > TUNNEL_VIDEO_MAX) {
        // The tunnel (this host's upload) can't keep up: every stream skips to its next keyframe.
        for (const c of this.chans.values()) { c.needsKey = true; this.askKey(c); }
        return;
      }
      if (ch.needsKey) return this.askKey(ch);
    }
    if (kind === 1) ch.needsKey = false;
    if (kind === 4 && buffered > TUNNEL_AUDIO_MAX) return;
    ws.send(frame(T.WS_DOWN, ch.chan, data));
  }

  askKey(ch) {
    const now = Date.now();
    if (now - ch.keyAt < 1000 || ch.local.readyState !== WebSocket.OPEN) return;
    ch.keyAt = now;
    ch.local.send(JSON.stringify({ t: 'keyframe' }));
  }

  // ---------------------------------------------------------------- library
  async fetchLibrary() {
    const r = await fetch(`${config.hubUrl}/node-api/lib`, {
      headers: { authorization: `Bearer ${config.nodeToken}` }, redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    log(`library from the hub: ${Array.isArray(data?.games) ? data.games.length : 0} game(s) this node can run`);
    return data;
  }

  // ---------------------------------------------------------------- shutdown
  async shutdown() {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    await this.manager.shutdown();          // each session's end reports {t:'gone'} (onChange)
    for (const rid of [...this.claimed]) this.gone(rid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise(ok => {
        const t = setTimeout(ok, 2000);
        ws.once('close', () => { clearTimeout(t); ok(); });
        ws.close(1000, 'node shutting down');
      });
    }
  }
}

function closeLocal(ch) {
  ch.pending = null;
  if (ch.local.readyState === WebSocket.CONNECTING) ch.local.terminate();
  else ch.local.close(1000);
}

/** Session info within the hub's size limits (the hub checks every field again). */
function fitInfo(info) {
  const i = { ...info };
  if (Array.isArray(i.apps) && i.apps.length > 200) i.apps = i.apps.slice(0, 200);
  return i;
}
