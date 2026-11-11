// Game files a session needs that are stored on a server (not behind a download link): the
// library's apks/roms and the companion files in files/.
//
// On a hub (or a plain Rose) they are local files. On a Rose node they live on the hub: they are
// fetched from its /node-api/files with the node's bearer token and their sha256 (from .../meta),
// into the node's own download cache (fetcher.js: CACHE_MB cap, LRU, size caps, checksum). Download
// links (apkUrl/romUrl/romTree) never come here: the node fetches those from the original site.
// The owner's Switch keys/firmware are never asked for: a node only ever uses its own.
import path from 'node:path';
import { config } from './config.js';
import * as fetcher from './fetcher.js';

const MAX_PARALLEL = 2;              // the hub sends each node at most 2 files at once (429 beyond)
const META_TIMEOUT_MS = 15 * 60_000; // hashing a multi-GB file on the hub takes a while
let running = 0;
const waiting = [];
const auth = () => ({ authorization: `Bearer ${config.nodeToken}` });
const fileUrl = (kind, name) => `${config.hubUrl}/node-api/files/${kind}/${encodeURIComponent(name)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function slot(fn) {
  if (running >= MAX_PARALLEL) await new Promise(r => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/** { size, sha256 } of a hub file (the hub answers with spaces until the hash is ready, then JSON). */
async function hubMeta(kind, name) {
  const r = await fetch(`${fileUrl(kind, name)}/meta`, { headers: auth(), redirect: 'error', signal: AbortSignal.timeout(META_TIMEOUT_MS) });
  const text = (await r.text()).trim();
  let m = null;
  try { m = JSON.parse(text); } catch {}
  if (r.status === 429) throw Object.assign(new Error('HTTP 429 from the main server'), { status: 429 });
  if (r.status === 404) throw Object.assign(new Error(`The main server would not send ${path.basename(name)} to this host.`), { status: 404 });
  if (!r.ok || !m || m.error || !/^[0-9a-f]{64}$/.test(m.sha256 || '')) {
    throw Object.assign(new Error(`Could not get ${path.basename(name)} from the main server (${m?.error || `HTTP ${r.status}`}).`), { status: 502 });
  }
  return m;
}

/**
 * A hub file in this node's cache: { path, release, sha256 }. kind: apk | rom | file | emu.
 * `store`: the name to keep it under (keep the extension: installers look at it).
 */
export async function hubFile(kind, name, store) {
  let meta = null;
  for (let attempt = 0; ; attempt++) {
    try {
      // The hub counts an uncached hash like a download (2 per node), so both run inside one slot.
      return await slot(async () => {
        meta ??= await hubMeta(kind, name);
        return fetcher.acquire(fileUrl(kind, name), { sha256: meta.sha256, name: store || path.basename(name), headers: auth() });
      });
    } catch (e) {
      // 429: an earlier transfer is still closing on the hub. Anything else is final.
      if (!/HTTP 429/.test(e.message) || attempt >= 5) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

const local = p => ({ path: p, release: async () => {} });

/** A companion file (library entry `file`, or a /push from files/): { path, release }. */
export async function file(name) {
  const n = path.basename(String(name));
  if (!config.nodeMode) return local(path.join(config.fileDir, n));
  return hubFile('file', n, n);
}

/** An entry's apk stored on the server (g.apk). */
export function apk(name, store) {
  if (!config.nodeMode) return Promise.resolve(local(path.join(config.apkDir, name)));
  return hubFile('apk', name, store || name);
}

/** An entry's console game stored on the server (g.rom, "<system>/<file>"). */
export function rom(name, store) {
  if (!config.nodeMode) return Promise.resolve(local(path.join(config.romDir, name)));
  return hubFile('rom', name, store || path.basename(name));
}
