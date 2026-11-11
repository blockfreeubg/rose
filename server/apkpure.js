// Exact files for pinned APKPure links.
//
// A link like https://d.apkpure.com/b/XAPK/<pkg>?versionCode=<n>&nc=arm64-v8a&sv=31 asks for one
// build of one version (here: the arm64 build that runs on Android 12, which Rose sessions are).
// d.apkpure.com honours that only over IPv6. Over IPv4, which is all a Docker container has by
// default, it ignores the query and sends its newest default build, often one that needs a newer
// Android. So a link can name the exact build in its fragment, "#asset=<id>" (the id APKPure's own
// app uses for that file; the fragment never reaches the site), and is then fetched through
// APKPure's app API, which hands out a fresh signed link to exactly that file. Links without the
// fragment, other sites, or a failed lookup are downloaded as they are.
const API = 'https://api.pureapk.com/m/v3/cms/app_version';
const SITE = /(^|\.)apkpure\.(com|net)$/i;
const PREFIX = Buffer.from('https://download.pureapk.com/b/');
// What APKPure's app sends: an Android 12 (API 31) device with 64-bit code, like a Rose session.
const HEADERS = { 'user-agent': 'Rose/1.0 (self-hosted game streaming)', 'x-sv': '31', 'x-abis': 'x86_64,arm64-v8a', 'x-gp': '1', 'x-cv': '3172501' };

/** { type, pkg, vc, asset } for a pinned APKPure link with an "#asset=" fragment, else null. */
export function pinned(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !SITE.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/b\/(XAPK|APK)\/([A-Za-z][\w.]*)\/?$/i);
  const vc = u.searchParams.get('versionCode') || '';
  const asset = new URLSearchParams(u.hash.slice(1)).get('asset') || '';
  if (!m || !/^\d{1,12}$/.test(vc) || !/^[0-9a-f]{1,16}$/i.test(asset)) return null;
  return { type: m[1].toUpperCase(), pkg: m[2], vc, asset: asset.toLowerCase() };
}

/**
 * A fresh direct link to the exact file a pinned link names: a string, or null when `url` isn't a
 * pinned link or APKPure no longer lists that file. Throws if the API can't be reached (an HTTP
 * answer sets err.status; err.final marks a reply not worth asking for again).
 */
export async function resolve(url, { signal } = {}) {
  const p = pinned(url);
  if (!p) return null;
  const res = await fetch(`${API}?hl=en-US&package_name=${encodeURIComponent(p.pkg)}`, { signal, headers: HEADERS });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`APKPure's app API answered HTTP ${res.status}`), { status: res.status });
  }
  const body = await readCapped(res, MAX_REPLY);
  for (const link of links(body)) {
    const a = assetOf(link);
    if (a && a.type === p.type && a.pkg === p.pkg && a.vc === p.vc && a.asset === p.asset) return link;
  }
  return null;
}

// A version list is ~1.5 MB for a game with 200 releases; anything far bigger isn't one.
const MAX_REPLY = 32 * 1024 * 1024;

/** The whole body of `res`, refusing (and dropping) one larger than `cap` bytes. */
async function readCapped(res, cap) {
  if (Number(res.headers.get('content-length')) > cap) {
    await res.body?.cancel().catch(() => {});
    throw Object.assign(new Error("APKPure's app API sent an oversized reply"), { final: true });
  }
  const parts = [];
  let n = 0;
  for await (const chunk of res.body || []) {
    n += chunk.length;
    if (n > cap) throw Object.assign(new Error("APKPure's app API sent an oversized reply"), { final: true });   // leaving the loop cancels the stream
    parts.push(chunk);
  }
  return Buffer.concat(parts.map(c => Buffer.from(c)));
}

/**
 * Every download link in an API reply. The reply is protobuf: each link is a string field, its
 * length (a varint) right before it, so a link is only taken whole, never cut short or run on.
 */
function links(buf) {
  const out = [];
  for (let at = buf.indexOf(PREFIX); at >= 0; at = buf.indexOf(PREFIX, at + 1)) {
    for (const n of [3, 2, 1]) {          // longest first: a 1-byte reading of a 2-byte length would cut the link
      if (at - n < 0) continue;
      let len = 0, ok = true;
      for (let k = 0; k < n; k++) {
        const b = buf[at - n + k];
        if ((k < n - 1) !== ((b & 0x80) !== 0)) { ok = false; break; }   // all but the last byte continue
        len += (b & 0x7f) * 2 ** (7 * k);
      }
      if (!ok || len < PREFIX.length || at + len > buf.length) continue;
      const s = buf.subarray(at, at + len);
      if (s.every(c => c > 0x20 && c < 0x7f)) { out.push(s.toString('latin1')); break; }
    }
  }
  return out;
}

/** { type, pkg, vc, asset } of an API download link: its path holds base64("<pkg>_<vc>_<asset>"). */
function assetOf(link) {
  try {
    const m = new URL(link).pathname.match(/^\/b\/([A-Z]+)\/([A-Za-z0-9+/_=-]+)$/);
    if (!m) return null;
    const id = Buffer.from(m[2], 'base64').toString('utf8');
    const j = id.lastIndexOf('_'), i = id.lastIndexOf('_', j - 1);   // package names can hold "_" too
    if (i <= 0) return null;
    return { type: m[1], pkg: id.slice(0, i), vc: id.slice(i + 1, j), asset: id.slice(j + 1).toLowerCase() };
  } catch {
    return null;
  }
}
