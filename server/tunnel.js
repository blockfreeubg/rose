// Rose node tunnel protocol, shared by the hub (nodes.js) and nodes (node-agent.js).
//
// One WebSocket per node, opened BY THE NODE to wss://<hub>/node/tunnel with
// "Authorization: Bearer rn_<nodeId>_<secret>" (never in the URL, never with an Origin header).
//
// Text frames: JSON control messages {t: ...} (see nodes.js for the full list).
// Binary frames: [type u8][chan u32 BE][payload]
//   0x01 WS_DOWN      node -> hub   stream packet for one browser: scrcpy kind byte (0-4) + data
//   0x02 WS_UP_TXT    hub  -> node  browser input (JSON text), already passed through sanitizeInput
//   0x03 REQ_BODY     hub  -> node  upload body chunk; chan = the request id (<= REQ_CHUNK bytes)
//   0x05 WS_DOWN_TXT  node -> hub   JSON text for one browser (pong, game state, audio unavailable)
import { sanitize as padState } from './gamepad.js';

export const PROTO = 1;
export const T = { WS_DOWN: 0x01, WS_UP_TXT: 0x02, REQ_BODY: 0x03, WS_DOWN_TXT: 0x05 };

export const LIMITS = {
  TUNNEL_MAX_PAYLOAD: 1024 * 1024,   // any one frame, either direction
  TEXT_MAX: 16 * 1024,               // node -> hub control text (except res)
  RES_MAX: 80 * 1024,                // node -> hub {t:'res'} text (its body <= RES_BODY_MAX)
  RES_BODY_MAX: 64 * 1024,
  HELLO_MAX: 16 * 1024,
  REQ_CHUNK: 256 * 1024,             // REQ_BODY payload
  UPLOAD_WINDOW: 4 * 1024 * 1024,    // unacked upload bytes in flight
  ACK_EVERY: 1024 * 1024,            // node acks uploads at least this often
  UPLOAD_MAX: 8 * 1024 ** 3,
  INPUT_TEXT_MAX: 1000,              // {t:'text'} string length
};

/** Build a binary frame. */
export function frame(type, chan, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const b = Buffer.allocUnsafe(5 + p.length);
  b[0] = type;
  b.writeUInt32BE(chan >>> 0, 1);
  p.copy(b, 5);
  return b;
}

/** Split a binary frame: { type, chan, payload } or null if it is too short. */
export function parseFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return null;
  return { type: buf[0], chan: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

/** Parse a text frame into an object with a string `t`, or null. */
export function parseText(raw, max = LIMITS.TEXT_MAX) {
  if (raw.length > max) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  return m && typeof m === 'object' && !Array.isArray(m) && typeof m.t === 'string' ? m : null;
}

// ---- Browser input (/ws, browser -> session) ----
// Only the game is ever shown: no Home, Recents or Power (a sleeping screen shows nothing).
// Volume up/down are not sent to the device any more: they would change the captured (remote submix)
// volume and draw the volume panel into the video. The page's own volume control replaces them.
export const NAV = { back: 4 };
// Raw keys that would leave the game or show system UI: HOME, POWER, CALL/ENDCALL, EXPLORER,
// ENVELOPE, MENU, NOTIFICATION, SEARCH, BUTTON_MODE (Home on a gamepad), SETTINGS, the app keys
// (CONTACTS, CALENDAR, MUSIC, CALCULATOR), APP_SWITCH, ASSIST, SLEEP, WAKEUP, VOICE_ASSIST,
// SOFT_SLEEP, the SYSTEM_NAVIGATION swipes (they open the shade) and ALL_APPS. Also VOLUME_UP/DOWN/MUTE
// (24, 25, 164): they'd change the game-audio capture level and show the volume panel in the video.
export const BLOCKED_KEYS = new Set([3, 24, 25, 26, 5, 6, 64, 65, 82, 83, 84, 110, 164, 176, 187, 207, 208, 209, 210, 219, 223, 224, 231, 276, 280, 281, 282, 283, 284]);
// Shift (0xc1), Alt (0x32), Ctrl (0x7000), caps/num/scroll lock (0x700000). No META/SYM/FUNCTION.
export const KEY_META = 0xc1 | 0x32 | 0x7000 | 0x700000;
export const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)));
const fin = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; };

/**
 * A browser's /ws message reduced to exactly what a session acts on, with every number clamped and
 * blocked keys dropped; null = nothing to do. The hub applies it before relaying to a node, and the
 * node (like a local session) applies it again. Fields not listed here never pass.
 */
export function sanitizeInput(m) {
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'hidden': case 'visible': case 'relaunch': case 'rotate': case 'keyframe':
      return { t: m.t };
    case 'audio': return { t: 'audio', on: m.on === true };
    case 'touch':
      return { t: 'touch', a: int(m.a, 0, 2), id: int(m.id, 0, 64), x: int(m.x, 0, 65535), y: int(m.y, 0, 65535),
        w: int(m.w, 0, 65535), h: int(m.h, 0, 65535), p: Math.max(0, Math.min(1, Number(m.p) || 1)) };
    case 'key': {
      const k = int(m.k, 0, 400);
      // Only Shift/Alt/Ctrl (and lock) meta bits: META (Search) + key opens apps, and Alt+Tab opens Recents.
      const meta = int(m.m, 0, 0x7fffffff) & KEY_META;
      if (BLOCKED_KEYS.has(k) || (k === 61 && meta & 0x32)) return null;
      return { t: 'key', a: int(m.a, 0, 1), k, m: meta };
    }
    case 'text':
      return typeof m.s === 'string' ? { t: 'text', s: m.s.slice(0, LIMITS.INPUT_TEXT_MAX) } : null;
    case 'scroll':
      return { t: 'scroll', x: int(m.x, 0, 65535), y: int(m.y, 0, 65535), w: int(m.w, 0, 65535), h: int(m.h, 0, 65535),
        hs: fin(m.hs, -16, 16), vs: fin(m.vs, -16, 16) };
    case 'nav': {
      const k = typeof m.k === 'string' && Object.hasOwn(NAV, m.k) ? m.k : null;   // not NAV['constructor'] etc.
      return k ? { t: 'nav', k } : null;
    }
    case 'ping': return { t: 'ping', ts: fin(m.ts, -1e15, 1e15) };
    case 'pad': return { t: 'pad', i: int(m.i, 0, 3), ...padState(m) };
    default: return null;
  }
}

// ---- Session -> browser text ----
const GAME_STATES = new Set(['restarted', 'exited', 'running']);
/** The only JSON a session (or a node) may send a browser, rebuilt from scratch; null = drop it. */
export function sanitizeDownText(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.t === 'pong' && typeof m.ts === 'number' && Number.isFinite(m.ts)) return { t: 'pong', ts: m.ts };
  if (m.t === 'game' && GAME_STATES.has(m.state)) return { t: 'game', state: m.state };
  if (m.t === 'audio' && m.available === false) return { t: 'audio', available: false };
  return null;
}

/** Plain text from an untrusted source: control characters removed, length capped. */
export function cleanText(s, max = 300) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, max);
}
