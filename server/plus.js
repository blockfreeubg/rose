// Rose+: a free TEST subscription. Nobody pays anything: any signed-in account turns it on or off on
// its Profile page (GET /api/me, PUT /api/me/plus). Members get Switch games (console entries and the
// emulator's own tile), no ads in the waiting line, and the front of that line (sessions.js).
// It exists only with accounts on (REQUIRE_ACCOUNT=1): with them off there is nobody to be a member,
// so nothing is gated and Rose works as it always did. A node never checks it: the hub does, before
// it forwards anything to one.
//
// apks/plus.json: { "<userId>": { "since": <ms>, "email": "<email>" } }; a key present = active.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { authConfig } from './auth.js';
import { SYSTEMS, byPackage } from './emulators.js';

export const NEED_PLUS = 'Switch games are part of Rose+. Turn it on in your profile.';

/** Rose+ exists on this server: accounts are required, and it is not a node. */
export const enabled = () => authConfig.required && !config.nodeMode;

const dbPath = () => path.join(config.apkDir, 'plus.json');
let db = null, loading = null;
let changes = Promise.resolve();   // set() runs here: one read-modify-write at a time

// Missing or unreadable means nobody is a member yet: it never stops the server. A corrupt file is
// copied aside first (plus.json.bad), since the next change writes a fresh one over it.
function load() {
  if (db) return Promise.resolve(db);
  loading ??= fs.readFile(dbPath(), 'utf8')
    .then(text => {
      const d = JSON.parse(text);
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not a JSON object');
      return d;
    })
    .catch(async e => {
      if (e.code === 'ENOENT') return {};
      console.warn(`plus.json could not be read (${e.message}): starting with no Rose+ members; the old file is kept as plus.json.bad`);
      await fs.copyFile(dbPath(), `${dbPath()}.bad`).catch(() => {});
      return {};
    })
    .then(d => { db = d; loading = null; return d; });
  return loading;
}

// Atomic: a crash mid-write leaves the old file, never half a new one.
async function write() {
  const tmp = `${dbPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, dbPath());
}

const has = (d, user) => !!user?.id && Object.hasOwn(d, user.id);

/** Is this signed-in user (req.user) a member? Always false with Rose+ off. */
export async function isPlus(user) {
  return enabled() && has(await load(), user);
}

/** What GET /api/me shows. */
export async function get(user) {
  const d = enabled() ? await load() : {};
  const e = has(d, user) ? d[user.id] : null;
  return { active: has(d, user), since: Number.isFinite(e?.since) ? e.since : null, test: true };
}

/** Turn Rose+ on or off for `user` (both are free). Resolves what get() then shows. */
export function set(user, active) {
  if (!enabled() || !user?.id) return Promise.reject(Object.assign(new Error('Rose+ needs a signed-in account.'), { status: 409 }));
  const run = changes.then(async () => {
    const d = await load();
    const was = has(d, user), old = d[user.id];
    if (active) {
      if (was && old?.email === user.email && Number.isFinite(old?.since)) return;   // already on: keep its date
      d[user.id] = { since: Number.isFinite(old?.since) ? old.since : Date.now(), email: user.email || '' };
    } else {
      if (!was) return;
      delete d[user.id];
    }
    try {
      await write();
    } catch (e) {
      if (was) d[user.id] = old; else delete d[user.id];   // not saved, so not changed either
      console.error(`plus.json: ${e.message}`);
      throw Object.assign(new Error('Couldn’t save your Rose+ setting. Try again.'), { status: 500 });
    }
  });
  changes = run.catch(() => {});
  return run.then(() => get(user));
}

/** An Android package that is a console emulator (Eden): the way to play Switch games. */
export const emulatorPkg = pkg => !!pkg && !!byPackage(pkg);

/**
 * Library entry `g` needs Rose+: a console game, or an emulator's own app (the Eden tile). The same
 * for everyone, so GET /api/library can mark it without breaking its caching.
 */
export function needsPlus(g) {
  if (!g) return false;
  if (g.system) return true;
  // The package, learned from the app itself on its first install, is the authority. Before that:
  // the emulator's official download, or a file named the way acquireEmulatorApk takes for it.
  if (g.pkg) return emulatorPkg(g.pkg);
  return Object.values(SYSTEMS).some(s => (!!g.apkUrl && g.apkUrl === s.apk?.url) || !!s.apk?.local?.test(g.apk || g.apkName || ''));
}

/** A 403 for a non-member: long() routes pass needPlus on, so the page can open the profile. */
export const needPlusError = () => Object.assign(new Error(NEED_PLUS), { status: 403, needPlus: true });
