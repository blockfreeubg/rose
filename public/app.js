// Rose UI: home (hero + rows), library, details, add/edit, launch flow and in-stream overlay.
import { startStream, KEYPAD_LEGEND, unlockAudio, audioSupported, audioPrefs, setAudioVolume, setAudioMuted } from './stream.js';
import { shippedProfile, sanitizeProfile, defaultEnabled, legend as keymapLegend, openEditor as openKeymapEditor } from './keymap.js';
import { getSession } from './queue.js';
import { initAuth, freshToken, authHeader, authLost, signOut } from './auth.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M11 10h2v7h-2zm0-3h2v2h-2zm1-5a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12z"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M8.6 17.6 10 19l7-7-7-7-1.4 1.4 5.6 5.6z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3zm0 9a2 2 0 0 0-1 3.7V19h2v-2.3A2 2 0 0 0 12 13z"/></svg>',
};

// ============================================================ API
let token = localStorage.getItem('rose-token') || '';
// Upload password (the #upload page): kept for this tab only, sent with every API call.
let uploadPass = sessionStorage.getItem('rose-upload-pass') || '';
const setUploadPass = p => { uploadPass = p; p ? sessionStorage.setItem('rose-upload-pass', p) : sessionStorage.removeItem('rose-upload-pass'); };
async function api(path, opts = {}) {
  await freshToken();   // accounts: renew the sign-in first if it's about to expire (no-op when off)
  const headers = { ...authHeader(), 'x-access-token': token, ...(uploadPass ? { 'x-upload-password': uploadPass } : {}), ...(opts.json ? { 'content-type': 'application/json' } : {}), ...(opts.reviewKey ? { 'x-review-key': opts.reviewKey } : {}) };
  // Time out instead of hanging for minutes when a tunnel/proxy stalls (long ops get a bigger budget).
  // That budget only covers waiting for the headers: after them the timer becomes an IDLE timeout,
  // re-armed by every body chunk. long() endpoints send their headers at once and then a space
  // every second, so a slow but healthy job (a multi-GB ROM download) runs as long as it needs,
  // while a dead tunnel still trips the timer within a minute.
  const ms = opts.timeout ?? (opts.method && opts.method !== 'GET' ? 10 * 60_000 : 15_000);
  const ctl = new AbortController();
  let timer, timedOut = false;
  const arm = t => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(); }, t); };
  const NO_ANSWER = 'The server is not responding. If you use a tunnel (e.g. Dev Tunnels), it may have disconnected.';
  arm(ms);
  let res;
  try {
    res = await fetch(path, { ...opts, headers, body: opts.json ? JSON.stringify(opts.json) : opts.body, signal: ctl.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(timedOut ? NO_ANSWER : `Can’t reach the server (${err.message})`);
  }
  // Accounts: "sign in first" (expired, signed out elsewhere, or accounts not set up) -> sign-in screen.
  if ([401, 403, 503].includes(res.status) && res.headers.get('content-type')?.includes('json')) {
    const d = await res.clone().json().catch(() => ({}));
    if (d.needAccount) { clearTimeout(timer); authLost(d.error); throw new Error(d.error || 'Sign in first'); }
  }
  if ([502, 503, 504].includes(res.status) || (res.status === 404 && !res.headers.get('content-type')?.includes('json'))) {
    clearTimeout(timer);
    throw new Error(`The connection to Rose failed (HTTP ${res.status}). Rose itself is fine; the tunnel/proxy in between is not reaching it.`);
  }
  if (res.status === 403 && res.headers.get('content-type')?.includes('json')) {
    const data = await res.clone().json().catch(() => ({}));
    if (data.needUploadPassword) {
      clearTimeout(timer);
      setUploadPass('');
      // The editor is modal: close it, or it would cover the unlock form it's sending people to.
      if ($('#addDialog').open) $('#addDialog').close();
      if (tab === 'upload') render();
      const msg = String(data.error || 'Wrong upload password').replace(/\.$/, '');
      throw new Error(/too many/i.test(msg) ? `${msg}.` : `${msg}. Unlock the upload page again.`);
    }
  }
  if (res.status === 401) {
    clearTimeout(timer);
    token = prompt('This Rose server needs an access token:') || '';
    localStorage.setItem('rose-token', token);
    return api(path, opts);
  }
  let text = '';
  try {
    if (res.body) {
      const reader = res.body.getReader(), dec = new TextDecoder();
      for (const idle = Math.min(ms, 60_000); ;) {
        arm(idle);
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
    }
  } catch (err) {
    // Never treat a cut-off body as success: long() already sent 200, so the result is unknown.
    throw new Error(timedOut ? NO_ANSWER : `The connection dropped before the server finished (${err.message}).`);
  } finally {
    clearTimeout(timer);
  }
  let data = {};
  try { if (text.trim()) data = JSON.parse(text); } catch { if (res.ok) throw new Error('The server’s answer was cut off before it finished. Try again.'); }
  // Only heartbeat spaces and no JSON: the long() job never finished (e.g. Rose restarted mid-way).
  if (res.ok && text && !text.trim()) throw new Error('The connection dropped before the server finished. Try again.');
  // Long operations answer 200 right away and report failure in the body (see long() in server/index.js).
  if (!res.ok || data.error) {
    // Rose+ (server/plus.js) refused a Switch game: the caller still gets the error, and the page
    // goes to the profile to say why (not while a game is on screen: the caller shows it there).
    if (data.needPlus) {
      // Said only to non-members: drop a stale member state first, so the profile is right at once.
      if (plusOn()) { me = { ...me, plus: { ...me.plus, active: false, since: null } }; syncPlus(); }
      if ($('#player').hidden) needPlus(data.error);
    }
    throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  }
  return data;
}

/**
 * Upload a form. Any large file field ("apk"/"file") is first streamed to the server in small
 * chunks, so it passes proxies and tunnels with request-size limits (Dev Tunnels -> HTTP 413);
 * the form then just references it by uploadId. onProgress gets 0..1.
 */
const CHUNK = 5 * 1024 * 1024;
async function upload(path, form, onProgress) {
  for (const field of ['apk', 'file']) {
    const f = form.get(field);
    if (!(f instanceof File) || !f.size) continue;
    const id = await sendChunked(f, onProgress);
    form.delete(field);
    form.set('uploadId', id);
    form.set('uploadName', f.name);
  }
  onProgress?.(1);
  return api(path, { method: 'POST', body: form });
}

// Resumable: the upload id is remembered per file, so re-adding the same file after a dropped
// connection continues from the last chunk the server has.
async function sendChunked(file, onProgress) {
  const key = `rose-up:${file.name}:${file.size}:${file.lastModified}`;
  let id = localStorage.getItem(key), offset = 0;
  if (id) {
    try { offset = (await api(`/api/uploads/${id}`)).size; } catch { id = null; offset = 0; }
    if (offset > file.size) { id = null; offset = 0; }
  }
  if (!id) {
    id = (await api('/api/uploads', { method: 'POST' })).id;
    localStorage.setItem(key, id);
  }
  onProgress?.(offset / file.size);
  let size = CHUNK;
  while (offset < file.size) {
    const end = Math.min(offset + size, file.size);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`/api/uploads/${id}?offset=${offset}`, {
          method: 'PUT', headers: { ...authHeader(), 'x-access-token': token, 'content-type': 'application/octet-stream' }, body: file.slice(offset, end),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 413 && size > 256 * 1024) { size = Math.floor(size / 2); break; }    // proxy limit: shrink chunks
        if (res.status === 409 && typeof data.size === 'number') { offset = data.size; break; } // resync after a lost response
        if (res.status === 404 && data.error) { localStorage.removeItem(key); throw Object.assign(new Error(data.error), { fatal: true }); }
        if (!res.ok) throw new Error(data.error || `upload failed (HTTP ${res.status})`);
        offset = data.size;
        break;
      } catch (err) {
        // Tunnels drop out for a while: back off up to ~1 minute per wait, ~5 minutes total.
        if (err.fatal || attempt >= 8) {
          throw new Error(err.fatal ? err.message : `Upload interrupted at ${Math.round((offset / file.size) * 100)}% (connection lost). Add the same file again to resume.`);
        }
        await sleep(Math.min(60_000, 1500 * 2 ** (attempt - 1)));
        // after an outage, re-check what actually arrived
        try { offset = (await api(`/api/uploads/${id}`)).size; } catch { /* still down */ }
        break;
      }
    }
    onProgress?.(offset / file.size);
  }
  localStorage.removeItem(key);
  return id;
}

// ============================================================ Toasts
function toast(msg, { type = 'ok', ms = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i></i><div></div>`;
  el.lastChild.textContent = msg;
  $('#toasts').append(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  if (ms) setTimeout(close, ms);
  return { close, set: (m, t) => { el.lastChild.textContent = m; if (t) el.className = `toast ${t}`; } };
}
const fail = err => toast(err.message || String(err), { type: 'err', ms: 7000 });

// ============================================================ State
let games = [];
let stats = { sessions: [], active: 0, max: 0, pooled: 0 };
let tab = 'home';
let activeCat = 'All';
// Rose+ (GET /api/me): who is signed in and whether they have the free test subscription.
let me = { accounts: false, user: null, plus: { active: false, since: null, test: true } };
let meOk = false;      // /api/me has answered at least once
let meErr = '';        // why the last /api/me failed ('' = it answered, or is still asking): #profile says so
let plusAsk = null;    // { msg, g }: why the visitor was sent to #profile (a game that needs Rose+)
const recent = JSON.parse(localStorage.getItem('rose-recent') || '{}'); // id -> last played ms
const saveRecent = () => localStorage.setItem('rose-recent', JSON.stringify(recent));
const savedSession = () => JSON.parse(localStorage.getItem('rose-session') || 'null');

const fmtSize = b => !b ? '' : b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? Math.round(b / 1e6) + ' MB' : Math.ceil(b / 1e3) + ' KB';
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const ago = t => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};
const formatOf = g => g.format || (/\.(apkm|apks|xapk)$/i.test(g.apk || '') ? `Split bundle (.${g.apk.split('.').pop().toLowerCase()})` : 'APK');
// Console games are played with a controller: the keyboard becomes one unless the player turns it off.
const padKeysFor = (g, uhid) => (g?.controls === 'gamepad'
  ? !noUhid(g, uhid) && localStorage.getItem('rose-padkeys') !== '0'
  : localStorage.getItem('rose-padkeys-apps') === '1');
// The server reports uhid === false when the host lacks the uhid module: its virtual gamepads then
// can't reach the emulator, so keys must not be turned into pad input (undefined = unknown, assume ok).
const noUhid = (g, uhid) => g?.controls === 'gamepad' && uhid === false;
const NO_UHID_MSG = 'Controllers can’t reach the emulator on this server: the host needs the uhid kernel module — run ./scripts/setup-host.sh or `sudo modprobe uhid`';
const byId = id => games.find(g => g.id === id);

// ============================================================ Art
const hue = str => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const initials = t => t.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
function gradient(g) {
  const h = hue(g?.title || 'Android');
  return `radial-gradient(120% 90% at 20% 15%, hsl(${h} 85% 58% / .9), transparent 55%), radial-gradient(90% 80% at 85% 90%, hsl(${(h + 50) % 360} 85% 52% / .75), transparent 60%), linear-gradient(135deg, hsl(${(h + 300) % 360} 55% 20%), hsl(${(h + 30) % 360} 60% 9%))`;
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l * 100];
  const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
// Accent colour sampled from a game's cover (same-origin only), cached across visits.
const tintCache = new Map((() => { try { return JSON.parse(localStorage.getItem('rose-tint') || '[]'); } catch { return []; } })());
const fallbackTint = g => `hsl(${hue(g?.title || 'Android')} 85% 60%)`;
function tintOf(g) {
  const u = g?.coverUrl;
  if (!u) return Promise.resolve(fallbackTint(g));
  if (tintCache.has(u)) return Promise.resolve(tintCache.get(u));
  return new Promise(res => {
    const i = new Image();
    i.decoding = 'async';
    i.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 12;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(i, 0, 0, 12, 12);
        const d = x.getImageData(0, 0, 12, 12).data;
        let r = 0, gg = 0, b = 0, w = 0;
        for (let k = 0; k < d.length; k += 4) {
          const R = d[k], G = d[k + 1], B = d[k + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 510;
          if (l < .1 || l > .92) continue;
          const s = mx ? (mx - mn) / mx : 0, wt = .1 + s * s;
          r += R * wt; gg += G * wt; b += B * wt; w += wt;
        }
        if (!w) return res(fallbackTint(g));
        const [hh, ss] = rgbToHsl(r / w, gg / w, b / w);
        const v = `hsl(${Math.round(hh)} ${Math.max(55, Math.round(ss))}% 60%)`;
        tintCache.set(u, v);
        try { localStorage.setItem('rose-tint', JSON.stringify([...tintCache].slice(-300))); } catch { /* quota */ }
        res(v);
      } catch { res(fallbackTint(g)); }
    };
    i.onerror = () => res(fallbackTint(g));
    i.src = u;
  });
}
const applyTint = (el, g, prop = '--glow') => { el.style.setProperty(prop, fallbackTint(g)); tintOf(g).then(t => el.style.setProperty(prop, t)); };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
/** Probes a banner's aspect ratio: calls back with 'portrait' or 'wide'. */
const probeShape = (u, cb) => { const im = new Image(); im.onload = () => cb(im.naturalWidth / im.naturalHeight < 1.2 ? 'portrait' : 'wide'); im.src = u; };

/** Fills an element with game art: key art (banner) when asked, else blurred backdrop + crisp icon, else initials on a mesh. */
function paintArt(el, g, { backdrop = true, key = false, w = 560 } = {}) {
  el.classList.add('art');
  el.classList.remove('has-key', 'is-portrait', 'art-broken');
  el.style.background = '';
  const icon = g?.coverUrl ? `url("${g.coverUrl}")` : '';
  const fallback = icon
    ? `${backdrop ? `<div class="art-bg" style='background-image:${icon}'></div>` : ''}<div class="art-icon" style='background-image:${icon}${backdrop ? '' : ';width:100%;height:100%;border-radius:0;box-shadow:none'}'></div>`
    : `<div class="art-initials">${esc(initials(g?.title || 'Android'))}</div>`;
  if (key && g?.banner) {
    el.classList.add('has-key');
    el.innerHTML = `${fallback}<img class="art-key" loading="lazy" decoding="async" alt="" src="${shot(g.banner, w)}">${icon ? `<div class="art-chip" style='background-image:${icon}'></div>` : ''}`;
    const im = el.querySelector('.art-key');
    im.onload = () => { if (im.naturalWidth / im.naturalHeight < 1.2) el.classList.add('is-portrait'); im.classList.add('loaded'); };
    im.onerror = () => { el.classList.remove('has-key'); im.remove(); el.querySelector('.art-chip')?.remove(); };
  } else el.innerHTML = fallback;
  if (!icon) el.style.background = gradient(g);
  else {
    const p = new Image();
    p.onerror = () => {
      el.classList.add('art-broken');
      el.style.background = gradient(g);
      el.querySelectorAll('.art-bg,.art-icon,.art-chip').forEach(n => n.remove());
      el.insertAdjacentHTML('afterbegin', `<div class="art-initials">${esc(initials(g.title || 'Android'))}</div>`);
    };
    p.src = g.coverUrl;
  }
}
const bgFor = (el, g, banner = false) => {
  el.classList.toggle('is-banner', !!(banner && g?.banner));
  el.style.backgroundImage = banner && g?.banner ? `url("${shot(g.banner, 1280)}")` : g?.coverUrl ? `url("${g.coverUrl}")` : gradient(g);
};

// ============================================================ Data
// Stats are cheap and polled; the library is only refetched when it changed: the server bumps
// stats.libraryVersion on every change (older servers lack it: then at most every 2 minutes).
// refresh() with no argument (after our own add/edit/remove, boot, session end) always refetches.
let libVer, libAt = 0, libStale = false;
async function refresh(force = true) {
  stats = await api('/api/stats');
  const ver = stats.libraryVersion;
  if (force || libStale || (ver === undefined ? Date.now() - libAt >= 120_000 : ver !== libVer)) {
    games = await api('/api/library');
    libVer = ver; libAt = Date.now(); libStale = false;
  }
  const t = $('#rigs');
  const free = stats.max - stats.active;
  t.classList.toggle('busy', free > 0 && free <= 1);
  t.classList.toggle('full', free <= 0);
  $('#rigsText').textContent = free <= 0 ? 'All rigs busy' : `${free} rig${free === 1 ? '' : 's'} free${stats.pooled ? ' · instant start' : ''}`;
  t.title = $('#rigsText').textContent; t.setAttribute('aria-label', t.title);
  // Only re-render when something visible changed, so background polling doesn't reset row scroll.
  const sig = JSON.stringify([games, stats.sessions.map(x => x.id), localStorage.getItem('rose-session'), Object.keys(recent)]);
  if (sig !== lastSig || force) { lastSig = sig; render(); }
}
let lastSig = '';

function liveSession() {
  const s = savedSession();
  const live = s && stats.sessions.find(x => x.id === s.id);
  if (!live && s) localStorage.removeItem('rose-session');
  return live ? { ...live, gameId: s.gameId } : null;
}

// ============================================================ Routing
let pageId = null;
function setTab(t) {
  tab = t;
  $$('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === t || (t === 'game' && a.dataset.tab === 'library')));
  $('#view-home').hidden = t !== 'home';
  $('#view-library').hidden = t !== 'library';
  $('#view-game').hidden = t !== 'game';
  $('#view-upload').hidden = t !== 'upload';
  $('#view-host').hidden = t !== 'host';
  $('#view-profile').hidden = t !== 'profile';
  // The top bar's avatar (auth.js) is the Profile tab on wide screens.
  const acct = $('#acctBtn');
  if (acct) { if (t === 'profile') acct.setAttribute('aria-current', 'page'); else acct.removeAttribute('aria-current'); }
  if (t !== 'profile') plusAsk = null;   // the reason for sending someone there is stale once they leave
  $('#gpSticky')?.classList.remove('on');
  scrollTo(0, 0);
  render();
}
function route() {
  const h = location.hash;
  if (h === '#profile') meErr = '';   // asked again below: "Loading…" until it answers, not an old error
  if (h.startsWith('#game/')) { pageId = decodeURIComponent(h.slice(6)); setTab('game'); }
  else setTab(h === '#library' ? 'library' : h === '#upload' ? 'upload' : h === '#host' ? 'host' : h === '#profile' ? 'profile' : 'home');
  if (tab === 'profile') loadMe().then(() => { if (tab === 'profile') render(); });   // fresh status (another tab may have changed it)
}
addEventListener('hashchange', route);
const solidBar = () => scrollY > 30 || tab === 'library' || tab === 'upload' || tab === 'host' || tab === 'profile';
addEventListener('scroll', () => $('#topbar').classList.toggle('solid', solidBar()), { passive: true });

function render() {
  $('#topbar').classList.toggle('solid', solidBar());
  if (tab === 'home') renderHome(); else if (tab === 'library') renderLibrary(); else if (tab === 'upload') renderUpload(); else if (tab === 'host') renderHost(); else if (tab === 'profile') renderProfile(); else renderGame();
}

// ============================================================ Tiles & rows
function tile(g, { live = false, sub, big = false } = {}) {
  const el = document.createElement('div');
  el.className = 'tile' + (live ? ' tile-live' : '');
  el.tabIndex = 0;
  const art = document.createElement('div');
  paintArt(art, g, { key: true, w: big ? 880 : 640 });
  applyTint(el, g);
  const badges = [
    live && '<span class="tag live">● LIVE</span>',
    !live && locked(g) && `<span class="tag plus" title="Needs Rose+">${ICON.lock}Rose+</span>`,   // a running one may go on
    g?.missing && '<span class="tag">File missing</span>',
    g?.systemName && `<span class="tag sys">${esc(g.systemName.replace(/^Nintendo /, ''))}</span>`,
    g?.file && '<span class="tag">+ data</span>',
  ].filter(Boolean).join('');
  art.insertAdjacentHTML('beforeend', `
    <div class="tile-badges">${badges}</div>
    <div class="tile-play"><span>${ICON.play}</span></div>
    ${g ? `<button class="tile-info" title="Details">${ICON.info}</button>` : ''}
    ${live ? '<div class="progress-line"></div>' : ''}`);
  el.append(art);
  el.insertAdjacentHTML('beforeend', `<div class="tile-title">${esc(g?.title || 'Android')}</div><div class="tile-sub">${g?.reviews ? `<span class="tile-stars">★ ${g.reviews.avg.toFixed(1)}</span> · ` : ''}${esc(sub ?? [g?.genre || g?.category, fmtSize(g?.size)].filter(Boolean).join(' · '))}</div>`);
  const go = () => (live ? resume() : play(g));
  el.addEventListener('click', e => { if (e.target.closest('.tile-info')) return showDetails(g); go(); });
  el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); if (e.key === 'i' && g) showDetails(g); });
  if (g) el.addEventListener('contextmenu', e => { e.preventDefault(); contextMenu(e, g); });
  return el;
}

function row(title, tiles, link) {
  const sec = document.createElement('section');
  sec.className = 'row';
  sec.innerHTML = `<div class="row-head"><h2>${esc(title)}${tiles.length > 1 ? `<small class="count">${tiles.length}</small>` : ''}</h2>${link ? `<a href="${link}">See all</a>` : ''}</div>
    <div class="row-wrap"><button class="row-arrow l" aria-label="Scroll left">${ICON.left}</button><div class="row-track"></div><button class="row-arrow r" aria-label="Scroll right">${ICON.right}</button></div>`;
  const track = sec.querySelector('.row-track');
  track.append(...tiles);
  const [l, r] = sec.querySelectorAll('.row-arrow');
  const upd = () => { l.disabled = track.scrollLeft < 8; r.disabled = track.scrollLeft + track.clientWidth > track.scrollWidth - 8; };
  l.onclick = () => track.scrollBy({ left: -track.clientWidth * 0.85, behavior: 'smooth' });
  r.onclick = () => track.scrollBy({ left: track.clientWidth * 0.85, behavior: 'smooth' });
  track.addEventListener('scroll', upd, { passive: true });
  // Left/right arrows move focus between tiles in a row.
  track.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const cur = e.target.closest('.tile');
    const next = cur && (e.key === 'ArrowRight' ? cur.nextElementSibling : cur.previousElementSibling);
    if (!next) return;
    e.preventDefault();
    next.focus({ preventScroll: true });
    next.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
  });
  requestAnimationFrame(upd);
  return sec;
}

// ============================================================ Home
let heroIdx = 0, heroTimer = null, heroList = [];
function renderHome() {
  const live = liveSession();
  const played = games.filter(g => recent[g.id]).sort((a, b) => recent[b.id] - recent[a.id]);
  heroList = [...played, ...games.filter(g => !recent[g.id]).sort((a, b) => (!!b.banner - !!a.banner) || ((b.reviews?.avg || 0) - (a.reviews?.avg || 0)) || (!!b.coverUrl - !!a.coverUrl))].filter(g => !g.missing).slice(0, 5);

  $('#hero').hidden = !games.length;
  $('#emptyHome').hidden = games.length > 0;
  if (games.length) { heroIdx = Math.min(heroIdx, heroList.length - 1); paintHero(); }

  const rows = [];
  const liveGame = live && byId(live.gameId);
  if (liveGame) {   // a session with no game has nothing to show: Play ends it (play() asks first)
    const g = liveGame;
    rows.push(row('Continue playing', [tile(g, { live: true, big: true, sub: `Running · ${fmtTime(live.uptimeSec)}` })]));
  }
  if (played.length) rows.push(row('Recently played', played.map(g => tile(g, { big: !live, sub: `Played ${ago(recent[g.id])}` }))));
  if (games.length) {
    const all = [...games].sort((a, b) => a.title.localeCompare(b.title));
    rows.push(row('My library', all.map(g => tile(g)), '#library'));
    const rated = games.filter(g => g.reviews).sort((a, b) => b.reviews.avg - a.reviews.avg || b.reviews.count - a.reviews.count);
    if (rated.length >= 3) rows.push(row('Top rated by players', rated.map(g => tile(g))));
    const fresh = [...games].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 15);
    rows.push(row('New in the library', fresh.map(g => tile(g))));
    const cats = [...new Set(games.map(g => g.category))].sort();
    if (cats.length > 1) for (const c of cats) {
      const inCat = all.filter(g => g.category === c);
      if (inCat.length >= 3) rows.push(row(c, inCat.map(g => tile(g))));
    }
  }
  rows[0]?.classList.add('row-lg');
  $('#rows').replaceChildren(...rows);
}

function paintHero(animate = false) {
  const g = heroList[heroIdx];
  if (!g) return;
  const bg = $('#heroBg');
  if (animate && !reducedMotion.matches && bg.style.backgroundImage) {
    // crossfade: a throwaway copy of the old backdrop fades out above the new one (under the shade and text)
    const cs = getComputedStyle(bg);
    const ghost = bg.cloneNode(false);
    ghost.removeAttribute('id');
    ghost.className = 'hero-ghost';
    ghost.style.filter = cs.filter; ghost.style.inset = cs.inset; ghost.style.transform = cs.transform;
    bg.after(ghost);
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  }
  writeHero(g);
}
function writeHero(g) {
  const hero = $('#hero');
  bgFor($('#heroBg'), g, true);
  hero.style.setProperty('--hero-tint', fallbackTint(g).replace('60%)', '60% / .22)'));
  tintOf(g).then(t => hero.style.setProperty('--hero-tint', t.replace('60%)', '60% / .22)')));
  $('#heroBlurb').textContent = g.blurb || '';
  hero.dataset.shape = g.banner ? '' : g.coverUrl ? 'icon' : 'none';
  $('#heroDevice').style.backgroundImage = g.banner ? `url("${shot(g.banner, 900)}")` : g.coverUrl ? `url("${g.coverUrl}")` : '';
  if (g.banner) probeShape(shot(g.banner, 1280), s => { if (heroList[heroIdx] === g) hero.dataset.shape = s; });   // same URL as the backdrop: one download
  paintArt($('#heroArt'), g, { backdrop: false });
  $('#heroEyebrow').textContent = recent[g.id] ? 'Jump back in' : 'Featured in your library';
  $('#heroTitle').textContent = g.title;
  $('#heroTitle').dataset.blurb = g.blurb || '';
  $('#heroMeta').innerHTML = [
    locked(g) && `<span class="tag plus" title="Needs Rose+">${ICON.lock}Rose+</span>`,
    g.reviews && `<span class="tag stars">★ ${g.reviews.avg.toFixed(1)} · ${g.reviews.count} review${g.reviews.count === 1 ? '' : 's'}</span>`,
    `<span class="tag">${esc(g.genre || g.category)}</span>`,
    g.developer && `<span class="tag">${esc(g.developer)}</span>`,
    g.size && `<span class="tag">${fmtSize(g.size)}</span>`,
    !locked(g) && (stats.pooled ? '<span class="tag ok">⚡ Instant start</span>' : '<span class="tag ok">Ready to play</span>'),
  ].filter(Boolean).join('');
  $('#heroPlay').innerHTML = locked(g) ? `${ICON.lock}Get Rose+` : `${ICON.play}Play`;   // play() sends a locked one to #profile
  $('#heroPlay').onclick = () => play(g);
  $('#heroInfo').onclick = () => showDetails(g);
  $('#heroDots').innerHTML = heroList.length > 1 ? heroList.map((h, i) => `<button class="${i === heroIdx ? 'on' : ''}" data-i="${i}" aria-label="Featured ${i + 1}: ${esc(h.title)}" style='background-image:url("${h.banner ? shot(h.banner, 400) : h.coverUrl || ''}")'><span>${esc(h.title)}</span></button>`).join('') : '';
  $('#heroDots').querySelectorAll('button').forEach(b => (b.onclick = () => { const i = +b.dataset.i; if (i !== heroIdx) { heroIdx = i; paintHero(true); } restartHero(); }));
  // re-trigger the staggered entrance animation
  $$('.hero-text > *').forEach(n => { n.style.animation = 'none'; n.offsetHeight; n.style.animation = ''; });
}
function restartHero() {
  clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    if (tab !== 'home' || heroList.length < 2 || $('#hero').matches(':hover') || document.hidden) return;
    heroIdx = (heroIdx + 1) % heroList.length;
    paintHero(true);
  }, 9000);
}

// ============================================================ Library
function renderLibrary() {
  const q = $('#search').value.trim().toLowerCase();
  const cats = ['All', ...[...new Set(games.map(g => g.category))].sort()];
  if (!cats.includes(activeCat)) activeCat = 'All';
  $('#chips').replaceChildren(...cats.map(c => {
    const b = document.createElement('button');
    b.className = 'chip' + (c === activeCat ? ' on' : '');
    b.textContent = c;
    b.onclick = () => { activeCat = c; renderLibrary(); };
    return b;
  }));
  const sort = $('#sort').value;
  const list = games
    .filter(g => (activeCat === 'All' || g.category === activeCat) && (!q || `${g.title} ${g.category}`.toLowerCase().includes(q)))
    .sort(sort === 'az' ? (a, b) => a.title.localeCompare(b.title)
      : sort === 'added' ? (a, b) => (b.addedAt || 0) - (a.addedAt || 0)
        : (a, b) => (recent[b.id] || 0) - (recent[a.id] || 0) || a.title.localeCompare(b.title));
  $('#libCount').textContent = games.length ? `${games.length}` : '';
  const tiles = list.map(g => tile(g, { sub: recent[g.id] ? `${g.category} · played ${ago(recent[g.id])}` : undefined }));
  tiles.forEach((el, i) => el.style.setProperty('--i', i));
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'no-results';
    d.textContent = q ? `No games match “${q}”.` : activeCat !== 'All' ? 'Nothing in this category yet.' : 'No games yet. Games added on the upload page show up here.';
    tiles.unshift(d);
  }
  $('#libGrid').replaceChildren(...tiles);
}
$('#sort').onchange = renderLibrary;
$('#search').addEventListener('input', () => { if (tab !== 'library') location.hash = '#library'; else renderLibrary(); });

// ============================================================ Context menu
function contextMenu(e, g) {
  document.querySelector('.ctx')?.remove();
  const m = document.createElement('div');
  m.className = 'ctx';
  const item = (icon, label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = cls; b.innerHTML = `${icon}<span>${esc(label)}</span>`;
    b.onclick = () => { m.remove(); fn(); };
    m.append(b);
  };
  item(locked(g) ? ICON.lock : ICON.play, locked(g) ? 'Get Rose+' : 'Play', () => play(g));
  item(ICON.info, 'Details', () => showDetails(g));
  if (uploadPass) {
    item(ICON.pencil, 'Edit', () => openEditor(g));
    item(ICON.trash, 'Remove', () => removeGame(g), 'danger');
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  setTimeout(() => addEventListener('click', () => m.remove(), { once: true }));
}

async function removeGame(g) {
  if (!confirm(`Remove “${g.title}” from your library?\n\nIts file is deleted from the server unless another entry uses it.`)) return;
  try {
    await api(`/api/library/${g.id}`, { method: 'DELETE' });
    delete recent[g.id]; saveRecent();
    if (tab === 'game') location.hash = '#library';
    $('#details').open && $('#details').close();
    toast(`Removed ${g.title}`);
    refresh();
  } catch (err) { fail(err); }
}

// ============================================================ Details
function showDetails(g) {
  if (!g) return;
  location.hash = `#game/${encodeURIComponent(g.id)}`;
}
function legacyDetails(g) {
  bgFor($('#dBg'), g, true);
  paintArt($('#dArt'), g, { backdrop: false });
  $('#dCat').textContent = g.category;
  $('#dTitle').textContent = g.title;
  const info = [
    g.systemName && ['System', `${g.systemName} · ${g.emulator} emulator`],
    ['Size', fmtSize(g.size) || '—'],
    ['Format', formatOf(g)],
    ['Stored', g.host ? `Downloaded from ${g.host} when you play` : 'On this server'],
    !g.system && ['Package', g.pkg || 'Detected on first launch'],
    ['Last played', recent[g.id] ? ago(recent[g.id]) : 'Never'],
    g.credit && ['By', g.credit],
    g.license && ['License', g.license],
    g.controls === 'gamepad' && ['Controls', 'Controller, keyboard (see the in-game menu) or touch'],
    g.file && ['Data file', g.file],
    ['File', g.fileName || g.apk],
  ].filter(Boolean);
  $('#dInfo').innerHTML = info.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')
    + (g.source ? `<div><dt>Project</dt><dd><a href="${esc(g.source)}" target="_blank" rel="noopener noreferrer">${esc(g.source.replace(/^https?:\/\/(www\.)?/, ''))}</a></dd></div>` : '');
  $('#dPlay').onclick = () => { $('#details').close(); play(g); };
  $('#dEdit').hidden = $('#dRemove').hidden = !uploadPass;
  $('#dEdit').onclick = () => { $('#details').close(); openEditor(g); };
  $('#dRemove').onclick = () => removeGame(g);
  $('#details').showModal();
}
$('#details').addEventListener('click', e => { if (e.target === e.currentTarget || e.target.closest('[data-close]')) $('#details').close(); });

// ============================================================ Add / edit
let editing = null;
$$('[data-action="add"]').forEach(b => (b.onclick = () => openEditor(null)));

async function openEditor(g) {
  if (!uploadPass) { location.hash = '#upload'; return; }
  editing = g;
  const f = $('#addForm'), E = f.elements;
  f.reset();
  $('#drop').classList.remove('has');
  $('#dropText').textContent = 'Drop a game file here or click to browse';
  $('#addTitle').textContent = g ? `Edit ${g.title}` : 'Add game';
  for (const el of [$('#drop'), $('#urlField'), $('#apkPick'), $('#coverField'), $('#fileField')]) el.hidden = !!g;
  $('#catList').innerHTML = [...new Set(games.map(x => x.category))].map(c => `<option value="${esc(c)}">`).join('');
  $('#metaFields').hidden = !g;
  if (g) {
    E.title.value = g.title; E.category.value = g.category;
    api(`/api/library/${g.id}/page`).then(p => {
      if (editing !== g) return;
      E.about.value = p.info.about || p.info.description || '';
      E.trailer.value = p.info.trailer ? `https://youtu.be/${p.info.trailer}` : '';
      E.screenshots.value = (p.info.screenshots || []).join('\n');
      E.about.dataset.orig = E.about.value; E.trailer.dataset.orig = E.trailer.value; E.screenshots.dataset.orig = E.screenshots.value;
    }).catch(() => {});
  }
  else {
    const files = [...new Set(games.map(x => x.apk).filter(Boolean))].sort();
    E.apkName.innerHTML = '<option value="">—</option>' + files.map(a => `<option>${esc(a)}</option>`).join('');
    $('#apkPick').hidden = !files.length;
    const extra = await api('/api/files').catch(() => []);
    E.file.innerHTML = '<option value="">None</option>' + extra.map(n => `<option>${esc(n)}</option>`).join('');
    $('#fileField').hidden = !extra.length;
  }
  $('#addDialog').showModal();
}

const drop = $('#drop');
drop.querySelector('input').addEventListener('change', e => {
  const f = e.target.files[0];
  drop.classList.toggle('has', !!f);
  $('#dropText').textContent = f ? `${f.name} · ${fmtSize(f.size)}` : 'Drop a game file here or click to browse';
});
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, () => drop.classList.add('over')));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));

// The ✕ and Cancel are type="button" (so Enter in a field picks Save as the default button) and close here.
$$('#addForm [value=cancel]').forEach(b => (b.onclick = () => $('#addDialog').close()));

$('#addForm').addEventListener('submit', async e => {
  if (e.submitter && e.submitter.value !== 'ok') return;
  e.preventDefault();
  const f = e.target, E = f.elements;
  const bar = $('#addProgress');
  $('#addSubmit').disabled = true;
  try {
    if (editing) {
      await api(`/api/library/${editing.id}`, { method: 'PATCH', json: { title: E.title.value, category: E.category.value } });
      const patch = {};
      for (const k of ['about', 'trailer', 'screenshots']) if (E[k].value !== (E[k].dataset.orig || '')) patch[k] = k === 'screenshots' ? E[k].value.split(/\s+/).filter(Boolean) : E[k].value.trim() || null;
      if (Object.keys(patch).length) { await api(`/api/library/${editing.id}/meta`, { method: 'PATCH', json: patch }); pageCache.delete(editing.id); }
      toast('Saved');
    } else {
      const link = E.url.value.trim();
      if (!E.apk.files.length && !E.apkName.value && !link) throw new Error('Choose a game file to upload, paste a download link, or pick a file from the server');
      const fd = new FormData(f);
      if (!E.apk.files.length) fd.delete('apk');
      if (!E.cover.files.length) fd.delete('cover');
      if (!link || E.apk.files.length) fd.delete('url');
      // Check the password first: a big file is uploaded in full before the library sees it.
      await api('/api/upload-login', { method: 'POST' });
      bar.hidden = false;
      let t;
      if (link && !E.apk.files.length) t = toast('Checking the download link…', { type: 'busy', ms: 0 });
      const g = await upload('/api/library', fd, p => (bar.firstElementChild.style.width = `${Math.round(p * 100)}%`)).finally(() => t?.close());
      toast(`${g.title} added to your library${g.apkUrl || g.romUrl ? ' (downloaded when you play it)' : ''}`);
    }
    $('#addDialog').close();
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    bar.hidden = true;
    bar.firstElementChild.style.width = '0';
    $('#addSubmit').disabled = false;
  }
});

// Drop a game file anywhere on the page to add it.
addEventListener('dragover', e => { if (tab === 'upload' && uploadPass && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
addEventListener('drop', e => {
  if (!e.dataTransfer?.files.length || !$('#player').hidden || tab !== 'upload' || !uploadPass) return;
  e.preventDefault();
  // Copy the files NOW: browsers empty e.dataTransfer as soon as this handler returns.
  const dt = new DataTransfer();
  for (const f of e.dataTransfer.files) dt.items.add(f);
  const put = () => {
    const input = drop.querySelector('input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  };
  if ($('#addDialog').open) put(); else openEditor(null).then(put);
});

// ============================================================ Upload page
function renderUpload() {
  const unlocked = !!uploadPass;
  $('#upLock').hidden = unlocked;
  $('#upPanel').hidden = !unlocked;
  if (!unlocked) { setTimeout(() => $('#upLogin').elements.pass.focus()); return; }
  renderHosts();
  $('#upCount').textContent = games.length ? `${games.length}` : '';
  const list = $('#upList');
  list.innerHTML = '';
  if (!games.length) { list.innerHTML = '<p class="up-hint">The library is empty. Click Add game to upload the first one.</p>'; return; }
  for (const g of [...games].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || a.title.localeCompare(b.title))) {
    const r = document.createElement('div');
    r.className = 'up-row';
    const art = document.createElement('div');
    art.className = 'up-art';
    paintArt(art, g, { backdrop: false });
    const where = g.host ? `Link · ${g.host}` : 'On this server';
    r.append(art);
    r.insertAdjacentHTML('beforeend', `<div class="up-text"><a class="up-title" href="#game/${encodeURIComponent(g.id)}">${esc(g.title)}</a>
      <div class="up-sub">${esc([g.systemName || g.category, fmtSize(g.size), where].filter(Boolean).join(' · '))}</div></div>
      <div class="up-actions"><button class="btn btn-ghost btn-sm" data-edit>Edit</button><button class="btn btn-ghost btn-sm btn-danger-text" data-del>Remove</button></div>`);
    r.querySelector('[data-edit]').onclick = () => openEditor(g);
    r.querySelector('[data-del]').onclick = () => removeGame(g);
    list.append(r);
  }
}
$('#upLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const pass = e.target.elements.pass.value, btn = $('#upLoginBtn');
  $('#upErr').textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch('/api/upload-login', { method: 'POST', headers: { ...authHeader(), 'x-access-token': token, 'x-upload-password': pass } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setUploadPass(pass);
    e.target.reset();
    render();
  } catch (err) {
    $('#upErr').textContent = err.message;
  } finally { btn.disabled = false; }
});
$('#upLock2').onclick = () => { setUploadPass(''); render(); };

// ============================================================ Hosts (Rose nodes; upload page)
// Other people's machines running sessions for this server. /api/nodes needs the upload password.
let hostsAt = 0, hostsBusy = false;
async function renderHosts() {
  if (hostsBusy) return;
  hostsBusy = true;
  let d;
  try { d = await api('/api/nodes'); } catch (err) {
    hostsBusy = false;
    if (err.status === 404) $('#upHosts').hidden = true;   // a server without nodes support
    return;
  }
  hostsBusy = false;
  hostsAt = Date.now();
  $('#upHosts').hidden = false;
  $('#hostPlace').value = d.scheduler;
  const online = d.nodes.filter(n => n.online).length;
  $('#hostCount').textContent = d.nodes.length ? `${online}/${d.nodes.length}` : '';
  const list = $('#hostList');
  list.innerHTML = '';
  if (!d.nodes.length) { list.innerHTML = '<p class="up-hint">No hosts yet. Create a join token and send its command to someone who wants to host.</p>'; return; }
  for (const n of d.nodes) {
    const sp = n.specs || {};
    const state = n.disabled ? 'Disabled' : !n.online ? 'Offline' : n.quarantinedUntil ? 'Held back' : n.degraded ? 'Failing starts' : 'Online';
    const specs = [sp.cpuModel, sp.arch === 'arm64' && 'ARM (ARM games only)', sp.threads && `${sp.threads} threads`, sp.ramMb && `${Math.round(sp.ramMb / 1024)} GB`,
      sp.gpu ? 'GPU' : sp.cpuModel && 'no GPU', sp.uhid && 'controllers', n.caps?.switch && 'Switch'].filter(Boolean).join(' · ');
    const use = n.online ? [`${n.active}/${n.limit} sessions`, n.rtt != null && `${n.rtt} ms`, n.version && `v${n.version}${n.outdated ? ' (update)' : ''}`].filter(Boolean).join(' · ')
      : n.lastSeen ? `last seen ${ago(n.lastSeen)}` : 'never connected';
    const r = document.createElement('div');
    r.className = 'up-row host-row';
    r.innerHTML = `<span class="host-dot ${n.online && !n.disabled ? 'on' : ''}" title="${esc(state)}"></span>
      <div class="up-text"><div class="up-title">${esc(n.name)} <span class="host-state">${esc(state)}</span></div>
        <div class="up-sub">${esc(use)}</div><div class="up-sub">${esc(specs || 'Specs appear once it connects')}</div></div>
      <div class="up-actions">
        <label class="host-cap" title="Most sessions this host gets (0 = as many as it can run)">Max <input type="number" min="0" max="64" class="input" value="${n.cap || 0}" data-cap></label>
        <button class="btn btn-ghost btn-sm" data-toggle>${n.disabled ? 'Enable' : 'Disable'}</button>
        <button class="btn btn-ghost btn-sm" data-end ${n.active ? '' : 'disabled'}>End sessions</button>
        <button class="btn btn-ghost btn-sm btn-danger-text" data-revoke>Revoke</button>
      </div>`;
    const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); } catch (err) { fail(err); } renderHosts(); };
    r.querySelector('[data-toggle]').onclick = () => act(() => api(`/api/nodes/${n.id}`, { method: 'PATCH', json: { disabled: !n.disabled } }),
      n.disabled ? `${n.name} gets new sessions again` : `${n.name} gets no new sessions; running ones continue`);
    r.querySelector('[data-cap]').onchange = e => act(() => api(`/api/nodes/${n.id}`, { method: 'PATCH', json: { cap: Number(e.target.value) || 0 } }), 'Saved');
    r.querySelector('[data-end]').onclick = () => confirm(`End every session running on ${n.name}?`)
      && act(() => api(`/api/nodes/${n.id}/end-sessions`, { method: 'POST' }), `Ended ${n.name}'s sessions`);
    r.querySelector('[data-revoke]').onclick = () => confirm(`Revoke ${n.name}'s token? Its sessions end now and it can't reconnect.`)
      && act(() => api(`/api/nodes/${n.id}`, { method: 'DELETE' }), `${n.name} removed`);
    list.append(r);
  }
}
// Keep the list live while the upload page is open (online state, slots, latency).
setInterval(() => { if (tab === 'upload' && uploadPass && !document.hidden && Date.now() - hostsAt > 9000 && !$('#upHosts').hidden) renderHosts(); }, 10_000);
$('#hostPlace').onchange = async e => {
  try { await api('/api/nodes/settings', { method: 'PUT', json: { scheduler: e.target.value } }); toast('Placement saved'); } catch (err) { fail(err); renderHosts(); }
};
$('#hostForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  $('#hostAdd').disabled = true;
  try {
    const t = await api('/api/nodes', { method: 'POST', json: { name } });
    e.target.reset();
    const box = $('#hostNew');
    box.hidden = false;
    const cmds = { linux: t.install, windows: t.installWindows, mac: t.installMac };
    box.innerHTML = `<div class="host-new-head"><b>Join token for ${esc(t.name)}</b><button class="btn btn-ghost btn-sm" data-x>Done</button></div>
      <p>Send the command for the host's system. They run it to install and start the node. <b>It is shown only once</b>, and anyone with it can join as this host: send it privately.</p>
      ${OS_TABS}
      <p data-os="linux">Linux (x86_64 or arm64, with Docker), in a terminal:</p>
      <p data-os="windows" hidden>Windows 10/11, in PowerShell. It installs Multipass and runs the node in a small Ubuntu VM: no GPU acceleration, so fewer players (about 2 on a 16 GB PC).</p>
      <p data-os="mac" hidden>macOS 14+ (Apple Silicon or Intel), in Terminal. It installs Multipass and runs the node in a small Ubuntu VM: no GPU acceleration, so fewer players (about 2 on a 16 GB Mac); on Apple Silicon, ARM games only.</p>
      ${Object.entries(cmds).map(([os, c]) => `<pre class="host-cmd" data-os="${os}" hidden>${esc(c || '(restart this server to get this command)')}</pre>`).join('')}
      <div class="host-new-actions"><button class="btn btn-play btn-sm" data-copy>Copy command</button><a class="link" href="#host">What the host needs</a></div>`;
    let os = osTabs(box);
    box.querySelectorAll('[data-os-tab]').forEach(b => b.addEventListener('click', () => { os = b.dataset.osTab; }));
    box.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(cmds[os] || '').then(() => toast('Copied'), () => toast('Select the command and copy it', { type: 'err' }));
    box.querySelector('[data-x]').onclick = () => { box.hidden = true; box.innerHTML = ''; };
    renderHosts();
  } catch (err) { fail(err); } finally { $('#hostAdd').disabled = false; }
});

// ============================================================ Host a Rose node (public page)
// Linux / Windows / macOS tabs: [data-os-tab] buttons show the [data-os] elements (a space-separated
// list of systems) of the picked system inside root. Starts on this browser's system; returns it.
const OS_TABS = `<div class="auth-tabs os-tabs" role="tablist" aria-label="Host's system">
  <button type="button" role="tab" data-os-tab="linux">Linux</button><button type="button" role="tab" data-os-tab="windows">Windows</button><button type="button" role="tab" data-os-tab="mac">macOS</button></div>`;
const guessOs = () => {
  const p = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent}`;
  return /\bwin/i.test(p) ? 'windows' : /mac|iphone|ipad/i.test(p) ? 'mac' : 'linux';
};
function osTabs(root, first = guessOs()) {
  const pick = os => {
    root.querySelectorAll('[data-os-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.osTab === os)));
    root.querySelectorAll('[data-os]').forEach(el => { el.hidden = !el.dataset.os.split(' ').includes(os); });
  };
  root.querySelectorAll('[data-os-tab]').forEach(b => { b.onclick = () => pick(b.dataset.osTab); });
  pick(first);
  return first;
}
let hostOsWired = false;
function renderHost() {
  const hub = location.origin;
  $('#hostCmd').textContent = `curl -fsSL ${hub}/node/install.sh | ROSE_NODE_TOKEN=rn_… bash -s -- --hub ${hub}`;
  $('#hostCmdWin').textContent = `[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; $env:ROSE_HUB_URL='${hub}'; $env:ROSE_NODE_TOKEN='rn_…'; irm ${hub}/node/install.ps1 | iex`;
  $('#hostCmdMac').textContent = `curl -fsSL ${hub}/node/install-mac.sh | ROSE_NODE_TOKEN=rn_… bash -s -- --hub ${hub}`;
  $('#hostUninstall').textContent = `curl -fsSL ${hub}/node/install.sh | bash -s -- --uninstall`;
  $('#hostUninstallWin').textContent = `[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; $env:ROSE_NODE_UNINSTALL='1'; irm ${hub}/node/install.ps1 | iex`;
  $('#hostUninstallMac').textContent = `curl -fsSL ${hub}/node/install-mac.sh | bash -s -- --uninstall`;
  if (!hostOsWired) { hostOsWired = true; osTabs($('#view-host .host-page')); }
}

/** "Hosted by" for a session on a Rose node (someone else's machine); hidden for this server's own. */
function paintHost(el, s) {
  const name = s?.host?.kind === 'node' ? s.host.name : '';
  el.hidden = !name;
  if (!name) return;
  el.innerHTML = `<b>Hosted by ${esc(name)}</b><span>This game runs on ${esc(name)}’s computer. Don’t type passwords into games on community hosts. <a class="link" href="#host" target="_blank" rel="noopener">More</a></span>`;
}

// ============================================================ Launch flow
let session = null;   // { id, game }
let stream = null;
let launchToken = 0;
let sessionStart = 0;
const TIPS = [
  'Press Ctrl + G any time for the in-game menu',
  'Right-click acts as Android’s Back button',
  'Plug in a controller: it works automatically',
  'Console games: W A S D to move, Z / X for A / B, Enter for +',
  'Use “Type text” in the menu for long text and passwords',
  'Closing the tab keeps your session alive for a couple of minutes',
];

function launchUI(g) {
  bgFor($('#lBg'), g, true);
  paintArt($('#lArt'), g, { backdrop: false });
  applyTint($('#launch'), g);
  $('#launch').dataset.shape = '';
  if (g?.banner) probeShape(shot(g.banner, 1280), s => ($('#launch').dataset.shape = s));
  $('#lTitle').textContent = g?.title || 'Android';
  $('#lStatus').classList.remove('err');
  $('#lCancel').textContent = 'Cancel';
  paintHost($('#lHost'), null);
  $('#launch').hidden = false;
  const t0 = Date.now();
  let tip = Math.floor(Math.random() * TIPS.length);
  $('#lTip').textContent = TIPS[tip];
  const timer = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    $('#lTime').textContent = fmtTime(s);
    if (Math.floor(s) % 6 === 5) $('#lTip').textContent = TIPS[++tip % TIPS.length];
  }, 1000);
  const steps = $$('#lSteps li');
  const set = (i, text) => {
    steps.forEach((li, j) => { li.classList.toggle('done', j < i); li.classList.toggle('active', j === i); });
    $('#lBar').style.width = `${Math.min(100, (i / steps.length) * 100 + 6)}%`;
    if (text) $('#lStatus').textContent = text;
  };
  return {
    set,
    error(msg) {
      clearInterval(timer);
      $('#lStatus').textContent = msg;
      $('#lStatus').classList.add('err');
      $('#lCancel').textContent = 'Back to library';
    },
    done() { clearInterval(timer); set(steps.length); setTimeout(() => ($('#launch').hidden = true), 250); },
    close() { clearInterval(timer); $('#launch').hidden = true; },
  };
}

function wsUrl(id) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?session=${id}&token=${encodeURIComponent(token)}`;
}

function connectStream(id, game, uhid) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('The stream did not start in time')), 20_000);
    const s = stream = startStream({
      canvas: $('#screen'),
      url: wsUrl(id),
      padKeys: padKeysFor(game, uhid),
      keymapLayer: $('#kmLayer'),
      inputBlocked: () => !$('#overlay').hidden || !$('#ended').hidden || document.activeElement === $('#textInput') || $('#player').hidden || !!kmEditor,
      onNotice: msg => toast(msg, { type: 'err', ms: 9000 }),
      onGame: state => gameEvent(s, state),
      onAudioState: () => { if (s === stream) syncSoundUI(); },
      onFirstFrame: () => { clearTimeout(to); resolve(); },
      onClose: e => {
        clearTimeout(to);
        s.dead = true;   // checked before showing the player: it may die during a long install
        reject(new Error(`Stream closed (${e.reason || e.code})`));
        if (session && !$('#player').hidden) { fail(new Error(`Disconnected: ${e.reason || 'connection lost'}`)); exitPlayer(false); }
      },
    });
    // stop() suppresses onClose, so settle here too: otherwise the 20 s timer of a cancelled
    // launch fires later and its rejection lands on whatever launch is running by then.
    const stop = s.stop;
    s.stop = () => { clearTimeout(to); reject(new Error('Stream stopped')); stop(); };
  });
}

// The socket can drop on its own during the minutes-long install while the session lives on:
// open a fresh one before showing the player instead of a frozen canvas.
async function reviveStream(id, game, uhid, ui) {
  if (!stream?.dead) return;
  ui.set(1, 'Reconnecting the stream…');
  stream.stop();
  await connectStream(id, game, uhid);
}

async function play(g) {
  // First, before any await: Safari unlocks audio only synchronously inside the click.
  unlockAudio();
  if (!g) return;   // Rose streams games only: there is no bare Android device to open
  if (locked(g)) return needPlus(null, g);   // a Switch game without Rose+: the server would refuse it too
  if (session) return toast('You already have a session running', { type: 'err' });
  if (!('VideoDecoder' in window)) return fail(new Error('This browser can’t decode the stream. Use Chrome, Edge or Safari 17+, over HTTPS or localhost.'));
  const live = liveSession();
  if (live) {
    if (!confirm('You have another session running. End it and start this game?')) return;
    await api(`/api/sessions/${live.id}`, { method: 'DELETE' }).catch(() => {});
    localStorage.removeItem('rose-session');
  }
  const my = ++launchToken;
  const ui = launchUI(g);
  const alive = () => my === launchToken;
  $('#lCancel').onclick = () => { launchToken++; ui.close(); if (session) endSession(); };
  try {
    ui.set(0, stats.pooled ? 'Grabbing a warm rig…' : 'Booting a fresh Android rig…');
    const s = await getSession(api, { alive, status: t => ui.set(0, t), game: g.id });
    if (!s || !alive()) return;
    session = { id: s.id, game: g, uhid: s.uhid, host: s.host, uploads: s.uploads };
    paintHost($('#lHost'), s);
    localStorage.setItem('rose-session', JSON.stringify({ id: s.id, gameId: g?.id }));
    if (!alive()) return endSession();

    ui.set(1, 'Connecting the stream…');
    await connectStream(s.id, g, s.uhid);
    if (!alive()) return;

    if (g) {
      ui.set(2, g.system ? `Setting up ${g.emulator} and ${g.title}…`
        : g.host ? `Downloading and installing ${g.title}…` : `Installing ${g.title}…`);
      const r = await api(`/api/sessions/${s.id}/play`, { method: 'POST', json: { game: g.id, launch: false } });
      if (!alive()) return;
      ui.set(3, `Launching ${g.title}…`);
      await api(`/api/sessions/${s.id}/launch`, { method: 'POST', json: { game: g.id, pkg: r.pkg } });
      recent[g.id] = Date.now(); saveRecent();
    }
    if (!alive()) return;
    await reviveStream(s.id, g, s.uhid, ui);
    if (!alive()) return;
    ui.done();
    enterPlayer();
  } catch (err) {
    if (!alive()) return;
    // The server says this needs Rose+ (e.g. it was cancelled in another tab): no session is kept
    // for it, and the profile page (api() already went there) says why.
    if (err.data?.needPlus) { launchToken++; ui.close(); if (session) endSession(); return needPlus(err.message, g); }
    ui.error(err.message);
    $('#lCancel').onclick = () => { ui.close(); endSession(); };
  }
}

async function resume() {
  unlockAudio();   // inside the click, before any await (see play())
  const live = liveSession();
  if (!live || session) return;
  const g = byId(live.gameId);
  // A session with no game (or one whose game left the library) would only show Android itself.
  if (!g) {
    localStorage.removeItem('rose-session');
    await api(`/api/sessions/${live.id}`, { method: 'DELETE' }).catch(() => {});
    toast('That session had no game to resume, so it was ended', { type: 'err' });
    return refresh();
  }
  const my = ++launchToken;
  const ui = launchUI(g);
  $('#lCancel').onclick = () => { launchToken++; ui.close(); stream?.stop(); stream = null; session = null; };
  session = { id: live.id, game: g, uhid: live.uhid, host: live.host, uploads: live.uploads };
  paintHost($('#lHost'), live);
  try {
    ui.set(1, 'Reconnecting to your session…');
    await connectStream(live.id, g, live.uhid);
    if (my !== launchToken) return;
    await reviveStream(live.id, g, live.uhid, ui);
    if (my !== launchToken) return;
    ui.done();
    enterPlayer();
  } catch (err) {
    if (my !== launchToken) return;   // cancelled: a newer launch may own the shared launch screen
    ui.error(err.message);
    session = null;
  }
}

// ============================================================ Player
let tickTimer = null, hudOn = localStorage.getItem('rose-hud') === '1';
function enterPlayer() {
  // Not liveSession(): its stats can predate a session created a moment ago, and it would then
  // forget the saved session (breaking "Continue playing").
  sessionStart = Date.now() - (stats.sessions.find(x => x.id === session.id)?.uptimeSec || 0) * 1000;
  const g = session.game;
  paintArt($('#oArt'), g, { backdrop: false });
  $('#oTitle').textContent = g?.title || 'Android';
  paintHost($('#oHost'), session);
  // A community host may not take players' own apps/files (uploads: false).
  $('#oApkRow').hidden = $('#oFileRow').hidden = session.uploads === false;
  $('#player').hidden = false;
  document.body.classList.add('playing');   // CSS stops rendering the page under the stream
  clearInterval(heroTimer);                  // no hero carousel behind the player
  $('#overlay').hidden = true;
  $('#ended').hidden = true;
  $('#hud').hidden = !hudOn;
  $('#hudSwitch').classList.toggle('on', hudOn);
  setupKeymap(g);
  syncPadUI();
  syncSoundUI();
  const hint = $('#hint');
  const kmOn = !stream?.padKeys && kmEnabled();
  hint.innerHTML = stream?.padKeys
    ? 'Your keyboard is a controller · <kbd>Ctrl</kbd> + <kbd>G</kbd> shows the keys'
    : kmOn ? `In landscape, ${keymapLegend(kmProfile()).slice(0, 2).map(([k, w]) => `<kbd>${esc(k)}</kbd> ${esc(w.split(' · ')[0].toLowerCase())}`).join(' · ')} · <kbd>Ctrl</kbd> + <kbd>G</kbd> → Edit controls to change keys or sizes`
    : 'Press <kbd>Ctrl</kbd> + <kbd>G</kbd> for the menu';
  hint.classList.remove('fade');
  setTimeout(() => hint.classList.add('fade'), stream?.padKeys || kmOn ? 7000 : 4500);
  if (noUhid(g, session.uhid)) toast(NO_UHID_MSG, { type: 'err', ms: 15000 });
  $('#screen').focus();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
  if (session.exited) showEnded();   // the game closed for good while the launch screen was up
}

function tick() {
  if (!stream) return;
  const s = stream.stats;
  const grade = (el, v, good, ok, lowerBetter = true) => {
    el.className = lowerBetter ? (v <= good ? 'good' : v <= ok ? 'ok' : 'bad') : (v >= good ? 'good' : v >= ok ? 'ok' : 'bad');
  };
  $('#sFps').textContent = s.fps; grade($('#sFps'), s.fps, 45, 25, false);
  $('#sRtt').textContent = `${Math.round(s.rtt)}ms`; grade($('#sRtt'), s.rtt, 40, 90);
  $('#sKbps').textContent = s.kbps > 1000 ? `${(s.kbps / 1000).toFixed(1)}M` : `${s.kbps}k`;
  $('#sRes').textContent = s.height ? `${Math.min(s.width, s.height)}p` : '–';
  $('#oTime').textContent = fmtTime((Date.now() - sessionStart) / 1000);
  if (hudOn) $('#hud').textContent = `${s.fps} fps   ${Math.round(s.rtt)} ms\n${(s.kbps / 1000).toFixed(1)} Mbps  ${s.width}×${s.height}`
    + (s.audioMs ? `\naudio ≈${s.audioMs} ms` : '');
}

const toggleOverlay = (show = $('#overlay').hidden) => {
  $('#overlay').hidden = !show;
  // Keys held now would never see their keyup on the device (input is blocked while the menu is up).
  if (show) stream?.releaseKeys();
  if (!show) $('#screen').focus();
};
addEventListener('keydown', e => {
  if ($('#player').hidden) return;
  if (e.ctrlKey && e.code === 'KeyG') { e.preventDefault(); e.stopImmediatePropagation(); if (!kmEditor) toggleOverlay(); }
  // stopImmediatePropagation: the menu is hidden by the time stream.js sees this key and would send Escape/Back.
  else if (e.code === 'Escape' && !$('#overlay').hidden) { e.preventDefault(); e.stopImmediatePropagation(); toggleOverlay(false); }
}, { capture: true });
$('#menuTab').onclick = () => toggleOverlay(true);
$('#oClose').onclick = () => toggleOverlay(false);
$$('#overlay [data-nav]').forEach(b => (b.onclick = () => stream?.nav(b.dataset.nav)));
$('#oRotate').onclick = () => stream?.rotate();
// Sound: browser-side volume and mute (the device itself stays at full volume; the server blocks
// its volume keys). Mute also tells the server to stop sending audio.
let soundOk = false;
audioSupported().then(ok => { soundOk = ok; syncSoundUI(); }).catch(() => {});
function syncSoundUI() {
  try {
    audioSupported().then(ok => { if (ok !== soundOk) { soundOk = ok; syncSoundUI(); } }).catch(() => {});   // e.g. no 48 kHz output
    const { muted, volume } = audioPrefs();
    const show = soundOk && stream?.audioAvailable !== false;   // browser can play it and the stream has it
    const pct = Math.round(volume * 100);
    $('#oSoundHead').hidden = $('#oSound').hidden = !show;
    $$('.ov-volbtn').forEach(b => (b.hidden = !show));
    $('.ov-grid').classList.toggle('no-vol', !show);
    $('#muteSwitch').classList.toggle('on', !muted);
    $('#oVol').value = pct;
    $('#oVol').style.setProperty('--fill', `${pct}%`);
    $('#oVol').disabled = muted;
    $('#oVolVal').textContent = muted ? 'Off' : `${pct}%`;
  } catch (e) { console.warn('sound controls', e); }
}
function setMuted(m) {
  setAudioMuted(m);
  if (!m) unlockAudio();   // a click: the moment to (re)start output
  stream?.syncAudio();
  syncSoundUI();
}
function setVolume(v) {
  setAudioVolume(v);
  if (audioPrefs().muted && v > 0) return setMuted(false);
  syncSoundUI();
}
$('#oMute').onclick = () => setMuted(!audioPrefs().muted);
$('#oVol').oninput = e => setVolume(e.target.value / 100);
$('#oVolDown').onclick = () => setVolume(Math.round(audioPrefs().volume * 10 - 1) / 10);
$('#oVolUp').onclick = () => setVolume(Math.round(audioPrefs().volume * 10 + 1) / 10);
syncSoundUI();
$('#oFs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('#player').requestFullscreen());
$('#oHud').onclick = () => {
  hudOn = !hudOn;
  localStorage.setItem('rose-hud', hudOn ? '1' : '0');
  $('#hud').hidden = !hudOn;
  $('#hudSwitch').classList.toggle('on', hudOn);
};
// Keyboard as controller 1 (on by default for console games, remembered separately for apps).
$('#padLegend').innerHTML = KEYPAD_LEGEND.map(([keys, what]) => `<div><kbd>${esc(keys)}</kbd><span>${esc(what)}</span></div>`).join('');
function syncPadUI() {
  const on = !!stream?.padKeys;
  $('#padSwitch').classList.toggle('on', on);
  $('#padLegend').hidden = !on;
}
$('#oPad').onclick = () => {
  if (!stream) return;
  const on = !stream.padKeys;
  if (on && noUhid(session?.game, session?.uhid)) return toast(NO_UHID_MSG, { type: 'err', ms: 9000 });
  stream.setPadKeys(on);
  localStorage.setItem(session?.game?.controls === 'gamepad' ? 'rose-padkeys' : 'rose-padkeys-apps', on ? '1' : '0');
  if (on && kmEnabled()) setKmEnabled(false);   // one or the other: both use W A S D
  syncPadUI();
  syncKmUI();
};

// Keyboard (and mouse) to touch for landscape touch games: keymap.js. The layout in use: the
// player's own (localStorage) > the server's ("Save for everyone") > shipped for this game > generic.
let km = null, kmEditor = null;   // km: { game, user, server }
const kmId = g => g?.id || '';
const kmLoad = g => { try { return sanitizeProfile(JSON.parse(localStorage.getItem(`rose-km:${kmId(g)}`) || 'null')); } catch { return null; } };
const kmBase = () => km?.server || shippedProfile(km?.game);
const kmProfile = () => km?.user || kmBase();
function kmEnabled() {
  if (!km) return false;
  const v = localStorage.getItem(`rose-km-on:${kmId(km.game)}`);
  return v === null ? defaultEnabled(km.game, { ...kmProfile(), server: !!km.server }) : v === '1';
}
function applyKeymap() {
  if (!stream?.keymap || !km) return;
  stream.keymap.setProfile(kmProfile());
  stream.keymap.setEnabled(kmEnabled());   // the mapper itself stays off while padKeys is on (and follows it back on)
  syncKmUI();
}
function setupKeymap(g) {
  km = { game: g, user: kmLoad(g), server: null };
  applyKeymap();
  if (!g?.id || g.system) return;
  api(`/api/keymaps/${encodeURIComponent(g.id)}`).then(p => {
    if (km?.game !== g) return;
    const prof = p && Array.isArray(p.controls) ? sanitizeProfile(p) : null;
    if (prof) { km.server = prof; applyKeymap(); }
  }).catch(() => {});
}
function setKmEnabled(on) {
  localStorage.setItem(`rose-km-on:${kmId(km?.game)}`, on ? '1' : '0');
  if (on && stream?.padKeys) {
    stream.setPadKeys(false);
    localStorage.setItem(session?.game?.controls === 'gamepad' ? 'rose-padkeys' : 'rose-padkeys-apps', '0');
    syncPadUI();
  }
  applyKeymap();
}
function syncKmUI() {
  const on = !!stream && !stream.padKeys && kmEnabled();
  $('#oKm').hidden = !!session?.game?.system;   // console games: the keyboard is a controller there
  $('#kmSwitch').classList.toggle('on', on);
  $('#kmLegend').hidden = !on;
  $('#kmTools').hidden = $('#oKm').hidden;
  $('#kmLabelSwitch').classList.toggle('on', stream?.keymap?.labels !== false);
  $('#kmLegend').innerHTML = keymapLegend(kmProfile()).map(([keys, what]) => `<div><kbd>${esc(keys)}</kbd><span>${esc(what)}</span></div>`).join('')
    + '<div><kbd>Enter</kbd><span>Chat: type normally</span></div><div><kbd>Tab</kbd><span>Show keys (hold)</span></div>';
}
$('#oKm').onclick = () => { if (stream && km) setKmEnabled(!(kmEnabled() && !stream.padKeys)); };
$('#oKmLabels').onclick = () => { stream?.keymap?.setLabels(!stream.keymap.labels); syncKmUI(); };
$('#oKmEdit').onclick = () => {
  if (!stream || !km || kmEditor) return;
  toggleOverlay(false);
  stream.releaseKeys();
  stream.keymap.setEditing(true);
  const g = km.game;
  kmEditor = openKeymapEditor({
    root: $('#player'), canvas: $('#screen'), title: g?.title || '', profile: kmProfile(), base: kmBase(),
    onSave: p => {
      if (p) localStorage.setItem(`rose-km:${kmId(g)}`, JSON.stringify(p)); else localStorage.removeItem(`rose-km:${kmId(g)}`);
      if (km?.game === g) { km.user = p; if (!kmEnabled()) setKmEnabled(true); else applyKeymap(); }
      toast(p ? 'Controls saved for you' : 'Back to the default controls');
    },
    onSaveGlobal: async p => {
      if (!uploadPass) {
        const pass = prompt('Upload password (saving controls for everyone):');
        if (!pass) throw new Error('cancelled');
        setUploadPass(pass);
      }
      try {
        const saved = await api(`/api/keymaps/${encodeURIComponent(g.id)}`, { method: 'PUT', json: p, timeout: 15_000 });
        localStorage.removeItem(`rose-km:${kmId(g)}`);   // everyone's layout is now this one
        if (km?.game === g) { km.server = sanitizeProfile(saved) || p; km.user = null; if (!kmEnabled()) setKmEnabled(true); else applyKeymap(); }
        toast('Controls saved for everyone');
      } catch (err) { fail(err); throw err; }
    },
    onClose: () => { kmEditor = null; stream?.keymap?.setEditing(false); $('#screen').focus(); },
  });
};
$('#oKbd').onclick = () => {
  toggleOverlay(false);
  stream?.releaseKeys();
  const t = $('#textInput');
  t.hidden = false;
  t.focus();
};
$('#textInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  // Focus moves to the canvas below, so without this the same key bubbles on to stream.js and
  // also reaches the device (Enter = START in console games, Escape = Back).
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Enter') { stream?.text(e.target.value); e.target.value = ''; }
  e.target.hidden = true;
  $('#screen').focus();
});
$('#apkUpload').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !session) return;
  const t = toast(`Uploading ${f.name}…`, { type: 'busy', ms: 0 });
  const fd = new FormData();
  fd.append('apk', f);
  try {
    const r = await upload(`/api/sessions/${session.id}/apk`, fd, p => t.set(p < 1 ? `Uploading ${f.name}… ${Math.round(p * 100)}%` : `Installing ${f.name}…`));
    t.set(`Installed ${r.packages.join(', ') || f.name}`, 'ok');
  } catch (err) { t.set(err.message, 'err'); }
  setTimeout(t.close, 5000);
};
$('#fileUpload').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !session) return;
  const t = toast(`Sending ${f.name}…`, { type: 'busy', ms: 0 });
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await upload(`/api/sessions/${session.id}/file`, fd, p => t.set(`Sending ${f.name}… ${Math.round(p * 100)}%`));
    t.set(`Saved to ${r.path}`, 'ok');
  } catch (err) { t.set(err.message, 'err'); }
  setTimeout(t.close, 5000);
};
$('#oLeave').onclick = () => exitPlayer(false);
$('#oEnd').onclick = () => exitPlayer(true);

// Server game watchdog. Players only ever see the game: when it leaves the foreground (crash,
// Back out of its first screen) the server relaunches it once ('restarted'); if it closes again
// soon after, or will not start, it gives up ('exited') until the player asks for a restart.
function gameEvent(s, state) {
  if (s !== stream || !session) return;   // a stale socket from an earlier launch
  if (state === 'restarted') {
    if ($('#ended').hidden) toast('The game closed, so it was restarted');
    return;
  }
  if (state === 'running') {   // started again (Restart game, or an uploaded app became the game)
    session.exited = false;
    $('#ended').hidden = true;
    return;
  }
  if ($('#player').hidden) { session.exited = true; return; }   // still launching: shown by enterPlayer()
  showEnded();
}
function showEnded() {
  session.exited = false;
  const title = session.game?.title || 'The game';
  toggleOverlay(false);
  stream?.releaseKeys();
  $('#textInput').hidden = true;
  paintArt($('#eArt'), session.game, { backdrop: false });
  applyTint($('#ended'), session.game);
  $('#eTitle').textContent = `${title} closed`;
  $('#eRestart').disabled = false;
  $('#ended').hidden = false;
  paintEndedPlus();
  $('#eRestart').hidden ? $('#eLeave').focus() : $('#eRestart').focus();
  if (session.game?.plus) loadMe().then(() => paintEndedPlus());   // Rose+ may have been cancelled in another tab
}
// Restarting is a new launch, so a Switch game needs Rose+ again (the server refuses it otherwise):
// a game that kept running after Rose+ was cancelled can't be started again from here.
function paintEndedPlus() {
  if (!session || $('#ended').hidden) return;
  const lock = locked(session.game), hadFocus = document.activeElement === $('#eRestart');
  $('#eRestart').hidden = lock;
  $('.ended-sub').textContent = lock
    ? 'Your session is still running, but starting a Switch game again needs Rose+. Turn it on in your profile, or go back to the library to end the session.'
    : 'Your session is still running. Restart the game, or go back to the library to end the session.';
  if (lock && hadFocus) $('#eLeave').focus();
}
$('#eRestart').onclick = () => {
  if (!stream?.relaunch()) return toast('Not connected: the game could not be restarted', { type: 'err' });
  $('#eRestart').disabled = true;   // re-enabled if the server reports 'exited' again
  $('#ended').hidden = true;
  $('#screen').focus();
};
$('#eLeave').onclick = () => exitPlayer(true);

async function endSession() {
  const s = session;
  session = null;
  stream?.stop(); stream = null;
  localStorage.removeItem('rose-session');
  if (s) await api(`/api/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {});
  refresh();
}

async function exitPlayer(end) {
  clearInterval(tickTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#player').hidden = true;
  document.body.classList.remove('playing');
  restartHero();
  $('#overlay').hidden = true;
  $('#ended').hidden = true;
  $('#textInput').hidden = true;
  kmEditor?.close();
  if (end) {
    const title = session?.game?.title;
    await endSession();
    toast(`Session ended${title ? ` · ${title}` : ''}`);
  } else {
    stream?.stop(); stream = null; session = null;
    toast('Session kept running: resume it from “Continue playing”');
    refresh();
  }
}

// ============================================================ Rose+ and the Profile page
// Rose+ is a free TEST subscription (server/plus.js): Switch games, no ads in the waiting line and
// priority in it. The server decides all of it: who is a member (/api/me), which games need it (the
// library's "plus" flag) and what may start; this page only shows it and sends people to #profile.
// Without accounts on the server there is no Rose+: nothing is locked and the Profile tab is hidden.
const NEED_PLUS = 'Switch games are part of Rose+. Turn it on in your profile.';
const plusOn = () => !!me.plus?.active;
/** A game this visitor can't start: Rose+ content, accounts on, not a member. */
const locked = g => !!g?.plus && me.accounts && !plusOn();
const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

async function loadMe() {
  try { me = await api('/api/me', { timeout: 15_000 }); meOk = true; meErr = ''; }
  catch (err) { meErr = err.message || 'The server didn’t answer.'; /* keep what we had: the server still decides */ }
  syncPlus();
  return me;
}
// What the page shows from /api/me: when it changes, the page is drawn again.
const meSig = () => JSON.stringify([meOk, me.accounts, me.user?.id, plusOn(), me.plus?.since]);
/** /api/me again (back from another tab, a new sign-in) and repaint what depends on it. */
function reloadMe() {
  const was = meSig();
  return loadMe().then(() => {
    paintEndedPlus();   // the "game closed" card: Restart follows Rose+ (nothing unless it is up)
    if (meSig() !== was && $('#player').hidden && $('#launch').hidden) render();
  });
}
function syncPlus() {
  document.body.classList.toggle('rose-plus', me.accounts && plusOn());   // the avatar's + badge (style.css)
  const t = $('.tabs .tab-profile');
  if (t) t.hidden = !me.accounts;
}

/** Off to #profile, saying why (`g`: the game that needs Rose+). Never pulls a player out of a game. */
function needPlus(msg, g = null) {
  plusAsk = { msg: msg || NEED_PLUS, g };
  if (!$('#player').hidden) return toast(plusAsk.msg, { type: 'err', ms: 8000 });
  if (location.hash !== '#profile') location.hash = '#profile'; else render();
}

function renderProfile() {
  $('#pfLoading').hidden = meOk;
  $('#pfOff').hidden = !meOk || me.accounts;
  $('#pfOn').hidden = !meOk || !me.accounts;
  if (!meOk) {
    // route() asks on the way in. A failed ask says why, with Try again (and Sign out, which needs
    // no server): never a silent "Loading…".
    $('#pfLoadMsg').textContent = meErr ? `Couldn’t load your profile. ${meErr}` : 'Loading your profile…';
    $('#pfRetry').hidden = !meErr;
    $('#pfErrOut').hidden = !meErr || !$('#acctBtn');   // the avatar is there only when signed in (auth.js)
    return;
  }
  if (!me.accounts) return;
  const email = me.user?.email || '';
  $('#pfAvatar').textContent = (email[0] || '?').toUpperCase();
  $('#pfEmail').textContent = email || 'Signed in';
  const on = plusOn();
  $('#pfTier').textContent = on ? 'Rose+ member (test)' : 'Free account';
  $('#pfTier').classList.toggle('on', on);
  $('#pfPlus').classList.toggle('on', on);
  $('#pfStatus').textContent = on ? (me.plus.since ? `Active since ${fmtDate(me.plus.since)}` : 'Active') : 'Not active';
  $('#pfStatus').classList.toggle('on', on);
  $('#pfStart').hidden = on;
  $('#pfCancel').hidden = !on;
  const ask = plusAsk, g = ask?.g && byId(ask.g.id);
  $('#pfAsk').hidden = !ask;
  $('#pfAsk').classList.toggle('on', on);
  if (ask) {
    $('#pfAsk').innerHTML = on
      ? (g ? `Rose+ is on: <b>${esc(g.title)}</b> is ready to play.` : 'Rose+ is on: Switch games are ready to play.')
      : g ? `<b>${esc(g.title)}</b> is part of Rose+. Switch games, the Eden emulator included, come with Rose+: start the free test below to play it.`
        : esc(ask.msg);
  }
  $('#pfPlay').hidden = !(on && g);
  if (on && g) $('#pfPlay').innerHTML = `${ICON.play}<span>Play ${esc(g.title)}</span>`;
  // Sent here from a game: the element that had the keyboard focus is gone, so offer the way on.
  // Again when a later render (a fresher /api/me) hid that button while it had the focus.
  const next = on ? ($('#pfPlay').hidden ? $('#pfCancel') : $('#pfPlay')) : $('#pfStart'), a = document.activeElement;
  if (ask && (!ask.focused || (ask.focused.hidden && (a === ask.focused || a === document.body)))) { ask.focused = next; next.focus({ preventScroll: true }); }
}
async function setPlus(active) {
  const btn = active ? $('#pfStart') : $('#pfCancel');
  btn.disabled = true;
  try {
    me = await api('/api/me/plus', { method: 'PUT', json: { active }, timeout: 15_000 });
    meOk = true;
    syncPlus();
    toast(active ? 'Rose+ is on: Switch games, no ads and priority in line' : 'Rose+ cancelled. A game that is already running keeps running.');
    render();
    // The pressed button is gone now: keep the keyboard focus on what took its place.
    (active ? ($('#pfPlay').hidden ? $('#pfCancel') : $('#pfPlay')) : $('#pfStart')).focus();
  } catch (err) { fail(err); } finally {
    btn.disabled = false;
    if (document.activeElement === document.body && !btn.hidden) btn.focus();   // disabling it dropped the focus
  }
}
$('#pfStart').onclick = () => setPlus(true);
$('#pfCancel').onclick = () => setPlus(false);
$('#pfPlay').onclick = () => { const g = plusAsk?.g && byId(plusAsk.g.id); if (g) play(g); };
$('#pfSignOut').onclick = $('#pfErrOut').onclick = () => signOut();
// Try again keeps the focus while it asks; once the profile is up, focus moves to its main button.
$('#pfRetry').onclick = async () => {
  const btn = $('#pfRetry');
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  $('#pfLoadMsg').textContent = 'Loading your profile…';
  await loadMe();
  delete btn.dataset.busy;
  const had = document.activeElement === btn;
  if (tab !== 'profile') return;
  render();
  if (had && meOk && me.accounts) (plusOn() ? $('#pfCancel') : $('#pfStart')).focus();
};

// ============================================================ Boot
addEventListener('error', e => fail(new Error(`Something broke: ${e.message}. Try reloading the page.`)));
addEventListener('unhandledrejection', e => fail(e.reason instanceof Error ? e.reason : new Error(String(e.reason))));
await initAuth();   // accounts (auth.js): waits on the sign-in screen when the server requires one
await loadMe();     // Rose+: before the first tiles, so their locks are right from the start
// From here on /api/me follows a new sign-in in this tab (auth.js: maybe another account, or it
// failed before) and, back from another tab, Rose+ turned on or off there (or a /api/me that never
// answered). Not while the sign-in screen is up: that ask would only send it back to "sign in".
addEventListener('rose-signed-in', () => reloadMe());
document.addEventListener('visibilitychange', () => {
  if (document.hidden || (meOk && !me.accounts) || document.body.classList.contains('signed-out')) return;
  reloadMe();
});
route();
refresh().catch(fail);
restartHero();
let polling = false;
async function poll() {
  if (polling || !$('#player').hidden || !$('#launch').hidden || document.hidden) return;
  polling = true;
  try { await refresh(false); } catch { /* shown on next user action */ } finally { polling = false; }
}
setInterval(poll, 15_000);
// Back to the tab: the library may have changed while polling was paused, so fetch it now
// (or on the next poll, if the player or launch screen is up).
document.addEventListener('visibilitychange', () => { if (!document.hidden) { libStale = true; poll(); } });

// ============================================================ Game page
const pageCache = new Map();   // id -> { info, reviews, admin }
const myKeys = JSON.parse(localStorage.getItem('rose-review-keys') || '{}');   // review id -> key
const saveKeys = () => localStorage.setItem('rose-review-keys', JSON.stringify(myKeys));
const starStr = n => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
// Remote images go through Rose's /img cache (tracker blockers stop direct Google CDN links).
const viaRose = u => `/img?u=${encodeURIComponent(u)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
// Play-store art: ask Google for that width as WebP (-rw), far smaller than the default JPEG/PNG.
const shot = (u, w) => viaRose(/googleusercontent\.com/.test(u) ? `${u}=w${w}-rw` : u);
let myRating = 0, renderedPage = null, stickyObs = null;

async function renderGame() {
  const g = byId(pageId);
  if (!g) {
    if (games.length) { $('#gpTitle').textContent = 'Game not found'; $('#gpAbout').textContent = 'It may have been removed from the library.'; }
    return;
  }
  const first = renderedPage !== g.id;
  renderedPage = g.id;
  if (first) { myRating = 0; $('#gpRevForm').reset(); paintStars(); }
  paintPage(g, pageCache.get(g.id));
  if (!pageCache.has(g.id) || first) {
    try {
      const p = await api(`/api/library/${encodeURIComponent(g.id)}/page`, { timeout: 30_000 });
      pageCache.set(g.id, p);
      if (pageId === g.id && tab === 'game') paintPage(byId(g.id) || g, p);
    } catch (err) { if (!pageCache.has(g.id)) fail(err); }
  }
}

function paintPage(g, p) {
  const info = p?.info || {}, reviews = p?.reviews || [];
  document.title = `${g.title} · Rose`;
  const banner = info.screenshots?.[0] || g.banner;
  const bg = $('#gpBg'), hero = $('.gp-hero');
  bg.classList.toggle('is-banner', !!banner);
  const bgUrl = banner ? shot(banner, 1280) : '';
  bg.style.backgroundImage = banner ? `url("${bgUrl}")` : g.coverUrl ? `url("${g.coverUrl}")` : gradient(g);
  const artG = info.icon && !g.coverUrl ? { ...g, coverUrl: viaRose(`${info.icon}=s256`) } : g;
  paintArt($('#gpArt'), artG, { backdrop: false });
  if (hero.dataset.for !== `${g.id}|${banner || ''}`) {
    hero.dataset.for = `${g.id}|${banner || ''}`;
    hero.dataset.shape = banner ? '' : artG.coverUrl ? 'icon' : 'none';
    if (banner) probeShape(bgUrl, s => { if (pageId === g.id) hero.dataset.shape = s; });
  }
  $('#gpDevice').style.backgroundImage = banner ? `url("${shot(banner, 900)}")` : artG.coverUrl ? `url("${artG.coverUrl}")` : '';
  applyTint($('#view-game'), artG, '--glow');
  hero.style.setProperty('--hero-tint', fallbackTint(artG).replace('60%)', '60% / .22)'));
  tintOf(artG).then(t => hero.style.setProperty('--hero-tint', t.replace('60%)', '60% / .22)')));
  // sticky mini playbar, shown once the main Play button scrolls out of view
  paintArt($('#gpStickyArt'), artG, { backdrop: false });
  $('#gpStickyTitle').textContent = g.title;
  // Rose+ content without Rose+: the main buttons lead to the profile instead of starting a session.
  const lock = locked(g);
  const go = () => (lock ? needPlus(null, g) : play(g));
  $('#gpStickyPlay').innerHTML = lock ? `${ICON.lock}Get Rose+` : `${ICON.play}Play`;
  $('#gpStickyPlay').onclick = go;
  if (!stickyObs) {
    stickyObs = new IntersectionObserver(([e]) => $('#gpSticky').classList.toggle('on', !e.isIntersecting && tab === 'game' && e.boundingClientRect.top < 0));
    stickyObs.observe($('#gpPlay'));
  }
  $('#gpCat').textContent = [g.systemName || 'Android', info.genre || g.category].filter(Boolean).join(' · ');
  $('#gpTitle').textContent = g.title;
  $('#gpBy').innerHTML = info.developer || g.credit
    ? `by ${info.developerUrl ? `<a href="${esc(info.developerUrl)}" target="_blank" rel="noopener noreferrer">${esc(info.developer)}</a>` : esc(info.developer || g.credit)}` : '';
  const avg = reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : 0;
  $('#gpMeta').innerHTML = [
    reviews.length ? `<span class="tag stars">★ ${avg.toFixed(1)} <small>(${reviews.length} review${reviews.length === 1 ? '' : 's'})</small></span>` : '<span class="tag">No reviews yet</span>',
    info.storeRating && `<span class="tag">${esc(info.storeName)} ★ ${info.storeRating} · ${fmtNum(info.storeRatings || 0)}</span>`,
    info.stars != null && `<span class="tag">★ ${fmtNum(info.stars)} GitHub stars</span>`,
    info.contentRating && `<span class="tag">${esc(info.contentRating)}</span>`,
    g.size && `<span class="tag">${fmtSize(g.size)}</span>`,
    g.controls === 'gamepad' && '<span class="tag">🎮 Controller</span>',
    lock ? '<span class="tag">Needs Rose+</span>' : `<span class="tag ok">${stats.pooled ? '⚡ Instant start' : 'Ready to play'}</span>`,
  ].filter(Boolean).join('');
  $('#gpPlay').innerHTML = lock ? `${ICON.lock}Get Rose+` : `${ICON.play}Play now`;
  $('#gpPlay').onclick = go;
  $('#gpPlus').hidden = !(g.plus && me.accounts);
  $('#gpPlus').innerHTML = lock
    ? `<span class="tag plus">${ICON.lock}Rose+</span><span>Switch games are part of Rose+, a free test subscription. Start it on your profile to play ${esc(g.title)}.</span>`
    : '<span class="tag plus">Rose+</span><span>Included in your Rose+.</span>';
  $('#gpTrailerBtn').hidden = !info.trailer;
  $('#gpTrailerBtn').onclick = () => openLightbox(mediaOf(info), 0);
  $('#gpReviewBtn').onclick = () => { $('#gpReviews').scrollIntoView({ behavior: 'smooth' }); setTimeout(() => $('#gpRevStars button')?.focus(), 400); };
  $('#gpMore').onclick = e => contextMenu(e, g);

  // media
  const media = mediaOf(info);
  $('#gpMedia').hidden = !media.length;
  $('#gpMediaTrack').replaceChildren(...media.map((m, i) => {
    const b = document.createElement('button');
    b.className = 'gp-shot' + (m.video ? ' video' : '');
    const src = m.video ? viaRose(`https://i.ytimg.com/vi/${m.video}/hqdefault.jpg`) : shot(m.src, 640);
    b.style.backgroundImage = `url("${src}")`;
    if (!m.video) {
      const im = new Image();
      im.onload = () => { const r = Math.min(21 / 9, Math.max(9 / 16, im.naturalWidth / im.naturalHeight)); b.style.aspectRatio = String(r); };
      im.src = src;
    }
    b.setAttribute('aria-label', m.video ? 'Play trailer' : `Screenshot ${i + 1}`);
    if (m.video) b.innerHTML = `<span>${ICON.play}</span>`;
    b.onclick = () => openLightbox(media, i);
    return b;
  }));

  // about
  const about = info.about || info.description;
  $('#gpAbout').textContent = about || (p ? (g.system ? `${g.title} runs in the ${g.emulator} emulator, streamed to your browser.` : `${g.title} runs on a real Android device in the cloud, streamed to your browser.`) : 'Loading…');
  $('#gpTopics').innerHTML = (info.topics || []).slice(0, 8).map(t => `<span class="chip">${esc(t)}</span>`).join('');
  $('#gpStore').innerHTML = info.storeUrl ? `<a href="${esc(info.storeUrl)}" target="_blank" rel="noopener noreferrer">More on ${esc(info.storeName)} ↗</a>` : '';

  // info sidebar
  const rows = [
    info.developer && ['Developer', info.developer],
    (info.genre || g.category) && ['Genre', info.genre || g.category],
    g.systemName && ['System', `${g.systemName} · ${g.emulator}`],
    ['Size', fmtSize(g.size) || '—'],
    ['Format', formatOf(g)],
    ['Stored', g.host ? `Streamed from ${g.host}` : 'On this server'],
    !g.system && g.pkg && ['Package', g.pkg],
    ['Last played', recent[g.id] ? ago(recent[g.id]) : 'Never'],
    g.license && ['License', g.license],
    g.addedAt && ['Added', new Date(g.addedAt).toLocaleDateString()],
  ].filter(Boolean);
  $('#gpInfo').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')
    + (g.source && !/apkpure/.test(g.source) ? `<div><dt>Project</dt><dd><a href="${esc(g.source)}" target="_blank" rel="noopener noreferrer">${esc(g.source.replace(/^https?:\/\/(www\.)?/, ''))}</a></dd></div>` : '');

  // reviews
  const dist = [5, 4, 3, 2, 1].map(n => [n, reviews.filter(r => r.rating === n).length]);
  $('#gpRevSummary').innerHTML = reviews.length ? `
    <div class="gp-rev-big"><b>${avg.toFixed(1)}</b><span class="stars-txt">${starStr(avg)}</span><small>${reviews.length} review${reviews.length === 1 ? '' : 's'}</small></div>
    <div class="gp-rev-bars">${dist.map(([n, c]) => `<div><span>${n}</span><i><em style="width:${(c / reviews.length) * 100}%"></em></i><small>${c}</small></div>`).join('')}</div>`
    : `<p class="muted">${p ? 'Be the first to review this game.' : ''}</p>`;
  $('#gpRevList').replaceChildren(...reviews.map(r => reviewEl(g, r, p?.admin)));

  // similar
  const similar = games.filter(x => x.id !== g.id && (x.category === g.category || (x.genre && x.genre === info.genre))).slice(0, 20);
  $('#gpSimilar').replaceChildren(...(similar.length ? [row('More like this', similar.map(x => tile(x)))] : []));
}

const mediaOf = info => [...(info.trailer ? [{ video: info.trailer }] : []), ...(info.screenshots || []).map(src => ({ src }))];

function reviewEl(g, r, admin) {
  const el = document.createElement('article');
  el.className = 'review';
  const mine = !!myKeys[r.id];
  el.innerHTML = `<header><span class="avatar" style="background:${gradient({ title: r.name })}">${esc(initials(r.name))}</span>
    <div><b>${esc(r.name)}</b>${mine ? ' <span class="tag mine">You</span>' : ''}<div class="stars-txt">${starStr(r.rating)} <small>${ago(r.at)}${r.edited ? ' · edited' : ''}</small></div></div>
    ${mine || admin ? '<button class="btn btn-ghost btn-sm" data-del>Delete</button>' : ''}</header>
    ${r.text ? `<p></p>` : ''}`;
  if (r.text) el.querySelector('p').textContent = r.text;
  el.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!confirm('Delete this review?')) return;
    try {
      await api(`/api/library/${g.id}/reviews/${r.id}`, { method: 'DELETE', reviewKey: myKeys[r.id] });
      delete myKeys[r.id]; saveKeys();
      pageCache.delete(g.id); renderedPage = null; await refresh();
    } catch (err) { fail(err); }
  });
  return el;
}

function paintStars() {
  $('#gpRevStars').innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" role="radio" aria-checked="${n === myRating}" aria-label="${n} star${n > 1 ? 's' : ''}" data-n="${n}" class="${n <= myRating ? 'on' : ''}">★</button>`).join('')
    + `<span class="muted">${['Tap to rate', 'Bad', 'Meh', 'OK', 'Good', 'Amazing'][myRating]}</span>`;
}
$('#gpRevStars').addEventListener('click', e => { const b = e.target.closest('[data-n]'); if (b) { myRating = +b.dataset.n; paintStars(); } });
$('#gpRevStars').addEventListener('mouseover', e => { const b = e.target.closest('[data-n]'); if (b) $$('#gpRevStars [data-n]').forEach(x => x.classList.toggle('hover', +x.dataset.n <= +b.dataset.n)); });
$('#gpRevStars').addEventListener('mouseleave', () => $$('#gpRevStars [data-n]').forEach(x => x.classList.remove('hover')));
const revText = $('#gpRevForm').elements.text;
revText.addEventListener('input', () => { $('#gpRevCount').textContent = revText.value.length > 1500 ? `${2000 - revText.value.length} left` : ''; });
$('#gpRevForm').elements.name.value = localStorage.getItem('rose-review-name') || '';
$('#gpRevForm').addEventListener('submit', async e => {
  e.preventDefault();
  const g = byId(pageId);
  if (!g) return;
  if (!myRating) return toast('Pick a star rating first', { type: 'err' });
  const E = e.target.elements;
  $('#gpRevSubmit').disabled = true;
  try {
    const r = await api(`/api/library/${g.id}/reviews`, { method: 'POST', json: { name: E.name.value, rating: myRating, text: E.text.value } });
    myKeys[r.id] = r.key; saveKeys();
    localStorage.setItem('rose-review-name', E.name.value);
    E.text.value = ''; myRating = 0; paintStars();
    toast('Thanks! Your review is posted');
    pageCache.delete(g.id); renderedPage = null;
    await refresh();
  } catch (err) { fail(err); } finally { $('#gpRevSubmit').disabled = false; }
});
paintStars();

// ---- lightbox (screenshots + trailer) ----
let lbItems = [], lbIdx = 0;
function openLightbox(items, i) {
  lbItems = items; lbIdx = i;
  paintLightbox();
  $('#lightbox').showModal();
}
function paintLightbox() {
  const m = lbItems[lbIdx];
  $('#lbStage').innerHTML = m.video
    ? `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.video)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="Trailer"></iframe>`
    : `<img src="${esc(shot(m.src, 1920))}" alt="Screenshot ${lbIdx + 1}">`;
  $('#lbCount').textContent = lbItems.length > 1 ? `${lbIdx + 1} / ${lbItems.length}` : '';
  $$('.lb-nav').forEach(b => (b.hidden = lbItems.length < 2));
}
const lbStep = d => { lbIdx = (lbIdx + d + lbItems.length) % lbItems.length; paintLightbox(); };
$('#lightbox').addEventListener('click', e => {
  const a = e.target.closest('[data-lb]')?.dataset.lb;
  if (a === 'close' || e.target === e.currentTarget) $('#lightbox').close();
  else if (a === 'prev') lbStep(-1); else if (a === 'next') lbStep(1);
});
$('#lightbox').addEventListener('close', () => ($('#lbStage').innerHTML = ''));
$('#lightbox').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') lbStep(-1); if (e.key === 'ArrowRight') lbStep(1); });
