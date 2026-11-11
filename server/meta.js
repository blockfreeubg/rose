// Game pages: store info (short description, developer, genre, screenshots, trailer) and player reviews.
//
// Store info is looked up once per game and cached in apks/meta.json:
//   Android apps  - the app's Google Play listing (short description, developer, genre, rating,
//                   screenshot links, trailer video id). Images stay on Google's CDN (linked, not copied).
//   GitHub source - the repo's description, owner, stars, homepage (Switch homebrew).
// Manual fields set via PATCH /api/library/:id/meta override what was looked up.
// Reviews live in apks/reviews.json: { [gameId]: [{ id, name, rating 1-5, text, at, keyHash }] }.
// Whoever posted a review gets a random key back and can delete it with that key; the
// server's access token (if one is set) can delete any review.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const metaPath = () => path.join(config.apkDir, 'meta.json');
const reviewsPath = () => path.join(config.apkDir, 'reviews.json');
// Google Play serves different pages per browser: the full one has every screenshot, the bare
// one carries the trailer's YouTube embed. Both are fetched.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const UA_BARE = 'Mozilla/5.0 (X11; Linux x86_64)';
const RETRY_MS = 6 * 3600_000;   // failed lookups are retried after this long

// Bumped whenever store info or reviews change (part of GET /api/stats' libraryVersion).
export let version = 0;

function store(file) {
  let cache = null, writing = Promise.resolve();
  return {
    async load() { return (cache ??= JSON.parse(await fs.readFile(file(), 'utf8').catch(() => '{}'))); },
    save() {
      version++;
      writing = writing.then(async () => {
        const tmp = file() + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(cache, null, 1));
        await fs.rename(tmp, file());
      }).catch(e => console.warn(`could not save ${file()}: ${e.message}`));
      return writing;
    },
  };
}
const metas = store(metaPath);
const reviews = store(reviewsPath);

const decode = s => String(s ?? '').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Android package of an entry: learned pkg, or the one in an APKPure-style link. */
export function pkgOf(g) {
  if (g.pkg) return g.pkg;
  const m = /\/(?:b\/[A-Z]+|[a-z-]+)\/([a-z][\w]*(?:\.[\w]+)+)(?:[/?]|$)/i.exec(g.apkUrl || '');
  return m ? m[1] : null;
}

async function get(url, json, ua = UA) {
  const res = await fetch(url, { headers: { 'user-agent': ua, 'accept-language': 'en-US,en' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json ? res.json() : res.text();
}

async function fromPlay(pkg) {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=US`;
  const [html, bare] = await Promise.all([get(url), get(url, false, UA_BARE).catch(() => '')]);
  const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find(j => j?.['@type'] === 'SoftwareApplication') || {};
  const shots = [...new Set([...html.matchAll(/<img src="(https:\/\/play-lh\.googleusercontent\.com\/[\w-]+)=[^"]*"[^>]*alt="Screenshot image"/g)].map(m => m[1]))];
  const trailer = /youtube\.com\/embed\/([\w-]{11})/.exec(html + bare)?.[1] || null;
  const genre = (ld.applicationCategory || '').replace(/^GAME_/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) || null;
  return {
    description: decode(ld.description) || null,
    developer: decode(ld.author?.name) || null,
    developerUrl: ld.author?.url || null,
    genre,
    contentRating: ld.contentRating || null,
    storeRating: ld.aggregateRating ? Math.round(parseFloat(ld.aggregateRating.ratingValue) * 10) / 10 : null,
    storeRatings: ld.aggregateRating ? parseInt(ld.aggregateRating.ratingCount, 10) : null,
    icon: ld.image || null,
    screenshots: shots.slice(0, 12),
    trailer,
    storeUrl: `https://play.google.com/store/apps/details?id=${pkg}`,
    storeName: 'Google Play',
  };
}

async function fromGitHub(source) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/.exec(source || '');
  if (!m) return null;
  const r = await get(`https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, '')}`, true);
  return {
    description: r.description || null,
    developer: r.owner?.login || null,
    developerUrl: r.owner?.html_url || null,
    stars: r.stargazers_count ?? null,
    homepage: r.homepage || null,
    topics: r.topics || [],
    updated: r.pushed_at || null,
    storeUrl: r.html_url,
    storeName: 'GitHub',
  };
}

const inflight = new Map();
/** Store info for an entry (looked up on first use, then cached). Never throws. */
export async function info(g) {
  const all = await metas.load();
  const cur = all[g.id];
  const fresh = cur && (cur.fetchedAt && (!cur.failed || Date.now() - cur.fetchedAt < RETRY_MS));
  if (fresh) return cur;
  if (inflight.has(g.id)) return inflight.get(g.id);
  const p = (async () => {
    let found = null, failed = false;
    try {
      const pkg = pkgOf(g);
      if (!g.system && pkg) found = await fromPlay(pkg);
      else if (g.source) found = await fromGitHub(g.source);
    } catch (e) {
      failed = true;
      console.warn(`store info for ${g.title}: ${e.message}`);
    }
    all[g.id] = { ...(cur?.manual ? { manual: cur.manual } : {}), ...(found || {}), ...(failed ? { failed: true } : {}), fetchedAt: Date.now() };
    await metas.save();
    return all[g.id];
  })().finally(() => inflight.delete(g.id));
  inflight.set(g.id, p);
  return p;
}

/** Manual overrides (description, screenshots, trailer, developer, genre...). null clears a field. */
const MANUAL = ['description', 'developer', 'genre', 'screenshots', 'trailer', 'released', 'about'];
export async function setManual(id, patch) {
  const all = await metas.load();
  const e = (all[id] ||= {});
  const manual = { ...(e.manual || {}) };
  for (const k of MANUAL) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (v === null || v === '') { delete manual[k]; continue; }
    if (k === 'screenshots') v = (Array.isArray(v) ? v : String(v).split(/\s+/)).filter(u => /^https:\/\//.test(u)).slice(0, 20);
    else if (k === 'trailer') v = /([\w-]{11})(?:[?&].*)?$/.exec(String(v))?.[1] || null;
    else v = String(v).slice(0, k === 'about' ? 4000 : 300);
    if (v) manual[k] = v;
  }
  e.manual = manual;
  await metas.save();
  return e;
}

export async function forget(id) {
  const [m, r] = await Promise.all([metas.load(), reviews.load()]);
  if (m[id] || r[id]) { delete m[id]; delete r[id]; await Promise.all([metas.save(), reviews.save()]); }
}

/** Force a new store lookup (keeps manual overrides). */
export async function refetch(g) {
  const all = await metas.load();
  if (all[g.id]) delete all[g.id].fetchedAt;
  return info(g);
}

// ---- reviews ----
const hash = k => crypto.createHash('sha256').update(String(k)).digest('hex');
const pub = r => ({ id: r.id, name: r.name, rating: r.rating, text: r.text, at: r.at, ...(r.edited ? { edited: r.edited } : {}) });

export async function summary() {
  const all = await reviews.load();
  return Object.fromEntries(Object.entries(all).filter(([, l]) => l.length).map(([id, l]) =>
    [id, { avg: Math.round((l.reduce((a, r) => a + r.rating, 0) / l.length) * 10) / 10, count: l.length }]));
}

export async function list(id) {
  return ((await reviews.load())[id] || []).map(pub).sort((a, b) => b.at - a.at);
}

const recentPosts = new Map();   // ip -> [timestamps]
export async function add(id, { name, rating, text }, ip) {
  rating = Math.round(Number(rating));
  if (!(rating >= 1 && rating <= 5)) throw Object.assign(new Error('Pick a rating from 1 to 5 stars'), { status: 400 });
  name = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Anonymous';
  text = String(text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  const now = Date.now();
  const times = (recentPosts.get(ip) || []).filter(t => now - t < 3600_000);
  if (times.length >= 10) throw Object.assign(new Error('Too many reviews from you in the last hour: try again later'), { status: 429 });
  recentPosts.set(ip, [...times, now]);
  const all = await reviews.load();
  const key = crypto.randomBytes(16).toString('hex');
  const r = { id: crypto.randomBytes(6).toString('hex'), name, rating, text, at: now, keyHash: hash(key) };
  (all[id] ||= []).push(r);
  await reviews.save();
  return { ...pub(r), key };
}

export async function edit(id, rid, key, { rating, text }) {
  const r = ((await reviews.load())[id] || []).find(x => x.id === rid);
  if (!r) throw Object.assign(new Error('review not found'), { status: 404 });
  if (!key || hash(key) !== r.keyHash) throw Object.assign(new Error('you can only edit your own review'), { status: 403 });
  if (rating !== undefined) {
    const n = Math.round(Number(rating));
    if (n >= 1 && n <= 5) r.rating = n;
  }
  if (text !== undefined) r.text = String(text).replace(/\r/g, '').trim().slice(0, 2000);
  r.edited = Date.now();
  await reviews.save();
  return pub(r);
}

export async function remove(id, rid, key, admin) {
  const all = await reviews.load();
  const l = all[id] || [];
  const i = l.findIndex(x => x.id === rid);
  if (i < 0) throw Object.assign(new Error('review not found'), { status: 404 });
  if (!admin && (!key || hash(key) !== l[i].keyHash)) throw Object.assign(new Error('you can only delete your own review'), { status: 403 });
  l.splice(i, 1);
  await reviews.save();
}

/** What's already cached for every game (no lookups): { [id]: merged info }. */
export async function cached() {
  const all = await metas.load();
  return Object.fromEntries(Object.entries(all).map(([id, { manual = {}, failed, fetchedAt, ...found }]) => [id, { ...found, ...manual }]));
}

/** Look up store info for every game that has none yet, one at a time, in the background. */
export async function warm(games) {
  const all = await metas.load();
  for (const g of games) {
    if (all[g.id]?.fetchedAt) continue;
    await info(g);
    await new Promise(r => setTimeout(r, 1500));
  }
}
