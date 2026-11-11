// Keyboard/mouse -> touch layouts ("keymaps") saved for everyone, per library game id.
// Stored in apks/keymaps.json: { [gameId]: profile }. Shipped defaults live in public/keymap.js;
// these override them. Profile: { v: 1, mode: 'touch'|'native', controls: [control] } where a
// control is one of
//   { type: 'stick',  x, y, r, up, down, left, right, mod }   (keys: KeyboardEvent.code; mod = walk)
//   { type: 'button', x, y, key, name }                        (key may be Mouse0/1/2)
//   { type: 'look',   x, y, w, h, sens }                       (mouse look region, centre + size)
// Positions are fractions (0..1) of the landscape video.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const file = () => path.join(config.apkDir, 'keymaps.json');
let cache = null, writing = Promise.resolve();
// A null-prototype map: ids like "__proto__" are plain keys. A corrupt file is kept aside, not fatal.
async function load() {
  if (cache) return cache;
  const text = await fs.readFile(file(), 'utf8').catch(() => '{}');
  let data;
  try { data = JSON.parse(text); } catch (e) {
    console.warn(`keymaps.json is not valid JSON (${e.message}); starting empty, old file kept as keymaps.json.bad`);
    await fs.copyFile(file(), file() + '.bad').catch(() => {});
  }
  cache ??= Object.assign(Object.create(null), data && typeof data === 'object' && !Array.isArray(data) ? data : {});
  return cache;
}
/** Writes are queued; the returned promise rejects if this write failed (the PUT then answers 500). */
function save() {
  const p = writing.then(async () => {
    const tmp = file() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(cache, null, 1));
    await fs.rename(tmp, file());
  });
  writing = p.catch(e => console.warn(`could not save keymaps.json: ${e.message}`));
  return p;
}

const bad = msg => Object.assign(new Error(msg), { status: 400 });
const MAX_CONTROLS = 64;
const KEY = /^[A-Za-z0-9]{0,24}$/;
function frac(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw bad(`${what} must be a number from 0 to 1`);
  return Math.round(n * 10000) / 10000;
}
function key(v, what) {
  const s = v === undefined || v === null ? '' : String(v);
  if (!KEY.test(s)) throw bad(`${what} is not a key name`);
  return s;
}

/** Validated copy of a profile, or throws a 400. */
export function sanitize(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('send a keymap object');
  if (!Array.isArray(p.controls)) throw bad('controls must be a list');
  if (p.controls.length > MAX_CONTROLS) throw bad(`at most ${MAX_CONTROLS} controls`);
  const out = { v: 1, mode: p.mode === 'native' ? 'native' : 'touch', controls: [] };
  let sticks = 0, looks = 0;
  for (const [i, c] of p.controls.entries()) {
    const at = `control ${i + 1}`;
    if (!c || typeof c !== 'object') throw bad(`${at} is not an object`);
    const base = { x: frac(c.x, `${at} x`), y: frac(c.y, `${at} y`) };
    if (c.type === 'stick') {
      if (++sticks > 2) throw bad('at most 2 joysticks');
      out.controls.push({ type: 'stick', ...base, r: frac(c.r, `${at} r`),
        ...Object.fromEntries(['up', 'down', 'left', 'right', 'mod'].map(k => [k, key(c[k], `${at} ${k}`)])) });
    } else if (c.type === 'button') {
      const name = String(c.name ?? '').slice(0, 24).replace(/[\u0000-\u001f<>]/g, '');
      // s: how big it is drawn (a fraction of the video width); the key always presses its centre.
      const s = c.s == null ? 0 : frac(c.s, `${at} size`);
      out.controls.push({ type: 'button', ...base, key: key(c.key, `${at} key`), ...(name ? { name } : {}), ...(s > 0 ? { s } : {}) });
    } else if (c.type === 'look') {
      if (++looks > 1) throw bad('at most 1 mouse look area');
      const sens = Number(c.sens ?? 1);
      if (!Number.isFinite(sens) || sens < 0.05 || sens > 10) throw bad(`${at} sensitivity must be 0.05 to 10`);
      out.controls.push({ type: 'look', ...base, w: frac(c.w, `${at} w`), h: frac(c.h, `${at} h`), sens: Math.round(sens * 100) / 100 });
    } else throw bad(`${at} has an unknown type`);
  }
  return out;
}

const okId = id => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
export async function get(id) {
  if (!okId(id)) return null;
  const all = await load();
  return Object.hasOwn(all, id) ? all[id] : null;
}
/** Save (or, with an empty/absent controls list and no mode, remove) the layout for a game. */
export async function put(id, body) {
  if (!okId(id)) throw bad('bad game id');
  const all = await load();
  if (!body || typeof body !== 'object' || (!Array.isArray(body) && !body.controls && !body.mode)) delete all[id];
  else all[id] = sanitize(body);
  await save();
  return all[id] ?? null;
}
