// Keyboard + mouse -> touch, for landscape touch games (Roblox, Fortnite, Free Fire, ...).
// W A S D drag a finger around a joystick, keys hold fingers on buttons, the mouse (pointer lock)
// drags a finger across a "look" area. Everything becomes ordinary multi-touch on the device
// ({t:'touch'} with finger ids 40..64, which real fingers/the mouse (0, 1, 2, ...) never reach).
//
// Profile: { v: 1, mode: 'touch'|'native', controls: [...] }, positions as fractions of the
// landscape video (so they hold at any stream size):
//   { type: 'stick',  x, y, r, up, down, left, right, mod }  r = radius / video width; mod = walk (half tilt)
//   { type: 'button', x, y, key, name, s }                    key: KeyboardEvent.code, or Mouse0/1/2; s = drawn size / video width (optional, looks only)
//   { type: 'look',   x, y, w, h, sens }                      centre + size of the mouse-look area
// mode 'native': the game reads the keyboard itself (Minecraft Java): mapping starts off.
// Which profile applies: the player's own (localStorage) > the server's (saved "for everyone")
// > the one shipped here for that package > GENERIC. The server validates the same shape (server/keymaps.js).

// ---------------------------------------------------------------- profiles
const stick = (x, y, r, more = {}) => ({ type: 'stick', x, y, r, up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD', mod: '', ...more });
const btn = (key, x, y, name) => ({ type: 'button', x, y, key, name });
const look = (x, y, w, h, sens = 1) => ({ type: 'look', x, y, w, h, sens });
const touch = (...controls) => ({ v: 1, mode: 'touch', controls });

// A standard mobile shooter HUD (Free Fire / CODM style). Positions are estimates of the default
// HUDs (the survey could not reach a live match in most of these): edit them in the overlay.
const shooter = ({ fire = [0.8, 0.58], aim = [0.92, 0.45], jump = [0.92, 0.62], crouch = [0.9, 0.86], reload = [0.76, 0.85], map = [0.92, 0.1], more = [] } = {}) => touch(
  stick(0.15, 0.7, 0.12),
  btn('Mouse0', ...fire, 'Fire'), btn('Mouse2', ...aim, 'Aim'), btn('Space', ...jump, 'Jump'),
  btn('KeyC', ...crouch, 'Crouch'), btn('KeyR', ...reload, 'Reload'), btn('KeyM', ...map, 'Map'),
  ...more,
  look(0.56, 0.38, 0.34, 0.44),
);

/** Shipped layouts, by Android package (or library id when the entry has no package). */
export const SHIPPED = {
  // Roblox TouchGui defaults (small-screen layout at 1280x720 / 280 dpi): DynamicThumbstick anywhere
  // in the lower left, jump bottom right. Camera: drag on the right half.
  'com.roblox.client': touch(stick(0.15, 0.72, 0.12), btn('Space', 0.915, 0.86, 'Jump'), look(0.64, 0.42, 0.46, 0.6)),
  'com.epicgames.fortnite': touch(
    stick(0.14, 0.72, 0.12),
    btn('Space', 0.92, 0.6, 'Jump'), btn('KeyC', 0.92, 0.8, 'Crouch'), btn('Mouse0', 0.8, 0.55, 'Fire'),
    btn('Mouse2', 0.9, 0.42, 'Aim'), btn('KeyR', 0.76, 0.8, 'Reload'), btn('KeyQ', 0.95, 0.25, 'Build'),
    btn('KeyM', 0.9, 0.1, 'Map'), look(0.56, 0.4, 0.36, 0.5),
  ),
  'com.dts.freefireth': shooter({ fire: [0.8, 0.62], aim: [0.93, 0.38], jump: [0.92, 0.55], crouch: [0.88, 0.86], reload: [0.73, 0.83], map: [0.92, 0.12], more: [btn('KeyZ', 0.95, 0.75, 'Prone')] }),
  'com.dts.freefiremax': shooter({ fire: [0.8, 0.62], aim: [0.93, 0.38], jump: [0.92, 0.55], crouch: [0.88, 0.86], reload: [0.73, 0.83], map: [0.92, 0.12], more: [btn('KeyZ', 0.95, 0.75, 'Prone')] }),
  'com.netease.newspike': shooter({ fire: [0.8, 0.55], aim: [0.93, 0.48], jump: [0.93, 0.65], crouch: [0.9, 0.86], reload: [0.76, 0.86], map: [0.1, 0.15] }),
  'com.miraclegames.farlight84': shooter(),
  'com.netease.ko': shooter(),
  'com.proxima.dfm': shooter(),
  '934ecac42612': shooter(),                       // Arena Breakout (no package in the library)
  'com.Mediatonic.FallGuys_client': touch(stick(0.15, 0.72, 0.12), btn('Space', 0.9, 0.78, 'Jump'), btn('ShiftLeft', 0.8, 0.86, 'Dive'), btn('KeyE', 0.9, 0.58, 'Grab'), look(0.6, 0.4, 0.4, 0.5)),
  // No jump and no camera: the view follows the player.
  'com.je.supersus': touch(stick(0.14, 0.72, 0.12), btn('KeyE', 0.9, 0.8, 'Use'), btn('KeyQ', 0.78, 0.82, 'Kill'), btn('KeyR', 0.9, 0.6, 'Report'), btn('KeyM', 0.93, 0.1, 'Map')),
  'com.innersloth.spacemafia': touch(stick(0.13, 0.74, 0.11), btn('KeyE', 0.9, 0.84, 'Use'), btn('KeyQ', 0.77, 0.84, 'Kill'), btn('KeyR', 0.9, 0.64, 'Report'), btn('KeyM', 0.95, 0.24, 'Map')),
  'com.mobile.legends': touch(stick(0.15, 0.72, 0.12), btn('Space', 0.89, 0.82, 'Attack'), btn('KeyQ', 0.74, 0.86, 'Skill 1'), btn('KeyE', 0.77, 0.68, 'Skill 2'), btn('KeyR', 0.86, 0.58, 'Skill 3'), btn('KeyF', 0.63, 0.88, 'Spell'), btn('KeyB', 0.5, 0.9, 'Recall')),
  // MojoLauncher (Minecraft Java) forwards a hardware keyboard to the game itself: native keys by
  // default. Its on-screen controls (measured live, default layout) for when mapping is turned on.
  'git.artdeell.mojo': {
    v: 1, mode: 'native', controls: [
      btn('KeyW', 0.106, 0.683, 'Forward'), btn('KeyA', 0.036, 0.81, 'Left'), btn('KeyD', 0.177, 0.81, 'Right'),
      btn('KeyS', 0.106, 0.935, 'Back'), btn('ShiftLeft', 0.106, 0.81, 'Sneak'), btn('Space', 0.893, 0.81, 'Jump'),
      btn('Mouse0', 0.036, 0.683, 'Attack'), btn('Mouse2', 0.177, 0.683, 'Use'), btn('KeyE', 0.177, 0.935, 'Inventory'),
      btn('KeyT', 0.17, 0.04, 'Chat'), btn('F5', 0.057, 0.113, '3rd person'), btn('Tab', 0.392, 0.04, 'Players'),
      look(0.55, 0.45, 0.5, 0.5),
    ],
  },
};
// The official GitHub build of MojoLauncher (x86_64, what the library installs) is git.artdeell.mjlaunch.
SHIPPED['git.artdeell.mjlaunch'] = SHIPPED['git.artdeell.mojo'];
/** Any other landscape game: WASD stick bottom left, Space jump bottom right, mouse look on the right. */
export const GENERIC = touch(stick(0.15, 0.72, 0.12), btn('Space', 0.88, 0.72, 'Jump'), look(0.62, 0.38, 0.4, 0.5));
// Library categories where mapping starts on even with only the generic layout.
const ACTION = new Set(['Action', 'Shooter', 'Sandbox', 'Adventure', 'Arcade', 'Horror', 'RPG', 'MOBA']);

const clone = p => JSON.parse(JSON.stringify(p));
export const shippedProfile = g => clone(SHIPPED[g?.pkg] || SHIPPED[g?.id] || GENERIC);
export const hasShipped = g => !!(SHIPPED[g?.pkg] || SHIPPED[g?.id]);
/** Whether keyboard-to-touch starts on for this game (before the player chooses). */
export function defaultEnabled(g, profile) {
  if (!g || g.system || g.controls === 'gamepad') return false;
  if (profile?.mode === 'native') return false;
  return hasShipped(g) || ACTION.has(g.category) || !!profile?.server;
}

// Size limits, as fractions of the video width (look: of each side). A stick's size is how far
// its finger slides; a button's is only how big it is drawn (its key presses the centre).
const SIZE = { stick: [0.03, 0.3], button: [0.015, 0.3], look: [0.08, 1] };
const clampSize = (c, v) => Math.round(Math.max(SIZE[c.type][0], Math.min(SIZE[c.type][1], v)) * 1000) / 1000;
/** Grow (f > 1) or shrink one control in place. `btnSize`: the drawn size of a button without its own. */
export function scaleControl(c, f, btnSize) {
  if (c.type === 'stick') c.r = clampSize(c, c.r * f);
  else if (c.type === 'button') c.s = clampSize(c, (c.s || btnSize) * f);
  else if (c.type === 'look') { c.w = clampSize(c, c.w * f); c.h = clampSize(c, c.h * f); }
}

const KEY_RE = /^[A-Za-z0-9]{0,24}$/;
const f01 = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d; };
const kc = v => (typeof v === 'string' && KEY_RE.test(v) ? v : '');
/** Clean copy of a stored/received profile, or null if it isn't one. */
export function sanitizeProfile(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.controls)) return null;
  const controls = [];
  for (const c of p.controls.slice(0, 64)) {
    if (!c || typeof c !== 'object') continue;
    const x = f01(c.x, 0.5), y = f01(c.y, 0.5);
    if (c.type === 'stick') controls.push({ type: 'stick', x, y, r: f01(c.r, 0.12) || 0.12, up: kc(c.up), down: kc(c.down), left: kc(c.left), right: kc(c.right), mod: kc(c.mod) });
    else if (c.type === 'button') controls.push({ type: 'button', x, y, key: kc(c.key), ...(c.name ? { name: String(c.name).slice(0, 24) } : {}), ...(Number(c.s) > 0 ? { s: clampSize(c, Number(c.s)) } : {}) });
    else if (c.type === 'look') controls.push({ type: 'look', x, y, w: f01(c.w, 0.4) || 0.4, h: f01(c.h, 0.5) || 0.5, sens: Math.max(0.05, Math.min(10, Number(c.sens) || 1)) });
  }
  return { v: 1, mode: p.mode === 'native' ? 'native' : 'touch', controls };
}

const KEYNAMES = {
  Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'R Shift',
  ControlLeft: 'Ctrl', ControlRight: 'R Ctrl', AltLeft: 'Alt', AltRight: 'R Alt', CapsLock: 'Caps', Tab: 'Tab',
  Enter: 'Enter', Backspace: 'Bksp', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn',
};
/** Short label for a KeyboardEvent.code (or Mouse0/1/2). */
export function keyLabel(code) {
  if (!code) return '—';
  if (KEYNAMES[code]) return KEYNAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
  return code;
}
const stickKeys = c => [c.up, c.left, c.down, c.right].map(keyLabel).join(' ');
/** [[keys, what], ...] for the menu legend and hints. */
export function legend(p) {
  const out = [];
  for (const c of p?.controls || []) {
    if (c.type === 'stick') { out.push([stickKeys(c), 'Move']); if (c.mod) out.push([keyLabel(c.mod), 'Walk (hold)']); }
    else if (c.type === 'button' && c.key) out.push([keyLabel(c.key), c.name || 'Button']);
    else if (c.type === 'look') out.push(['Mouse', 'Look · click to aim, Esc frees it']);
  }
  return out;
}

// ---------------------------------------------------------------- engine
const ID_FIRST = 40, ID_LAST = 64;   // finger ids for mapped touches (the server allows 0..64)
const AIM_KEY = 'Backquote', CHAT_KEY = 'Enter', PEEK_KEY = 'Tab';
const DIAG = Math.SQRT1_2;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * The live mapper inside one stream (stream.js creates it).
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {(m: object) => boolean} o.send
 * @param {() => [number, number]} o.size   current video width/height
 * @param {() => boolean} o.padKeys         keyboard-as-controller is on (then mapping is off)
 * @param {Function} o.on                   addEventListener bound to the stream's lifetime
 * @param {HTMLElement} [o.layer]           element over the stream for key labels and tips
 */
export function createKeymapper({ canvas, send, size, padKeys, on, layer }) {
  let profile = null, enabled = false, editing = false, suspended = false;
  let binds = new Map();              // code -> true (mapped by the profile)
  const held = new Set();             // mapped codes held down while active
  const fingers = new Map();          // control key -> { id, x, y, ready }
  let wasActive = false, armed = true, selfUnlock = false, escUntil = 0, peek = false;
  let lookC = null, lookRaf = 0, lookIdle = 0;
  const lookAcc = [0, 0];
  let recentUps = [];                 // { id, x, y, t }: ups that may have been dropped by a rotation in flight
  let labelsOn = localStorage.getItem('rose-km-labels') !== '0';

  const landscape = () => { const [w, h] = size(); return w > 0 && w > h; };
  const active = () => enabled && !editing && !suspended && !!profile?.controls.length && landscape() && !padKeys();
  const locked = () => document.pointerLockElement === canvas;

  function rebuild() {
    binds = new Map();
    lookC = null;
    for (const c of profile?.controls || []) {
      if (c.type === 'stick') for (const k of [c.up, c.down, c.left, c.right, c.mod]) { if (k) binds.set(k, true); }
      else if (c.type === 'button' && c.key) binds.set(c.key, true);
      else if (c.type === 'look') lookC = c;
    }
  }
  const freeId = () => {
    const used = new Set([...fingers.values()].map(f => f.id));
    for (let id = ID_FIRST; id <= ID_LAST; id++) if (!used.has(id)) return id;
    return -1;
  };
  function touchAt(a, f) {
    const [w, h] = size();
    if (!w) return;
    const x = Math.max(0, Math.min(w - 1, f.x * w)), y = Math.max(0, Math.min(h - 1, f.y * h));
    send({ t: 'touch', a, id: f.id, x, y, w, h, p: a === 1 ? 0 : 1 });
  }
  function lift(key) {
    const f = fingers.get(key);
    if (!f) return;
    clearTimeout(f.timer);
    touchAt(1, f);
    fingers.delete(key);
    const t = performance.now();
    recentUps = recentUps.filter(u => t - u.t < 1500 && u.id !== f.id);
    recentUps.push({ id: f.id, x: f.x, y: f.y, t });
  }
  function liftAll() { for (const k of [...fingers.keys()]) lift(k); lookAcc[0] = lookAcc[1] = 0; }

  // Where each control's finger should be, from the keys held now.
  function desired() {
    const want = new Map();
    (profile?.controls || []).forEach((c, i) => {
      if (c.type === 'stick') {
        let dx = (held.has(c.right) ? 1 : 0) - (held.has(c.left) ? 1 : 0);
        let dy = (held.has(c.down) ? 1 : 0) - (held.has(c.up) ? 1 : 0);
        if (!dx && !dy) return;
        if (dx && dy) { dx *= DIAG; dy *= DIAG; }
        const [w, h] = size();
        const r = c.r * (c.mod && held.has(c.mod) ? 0.45 : 1);
        want.set(`s${i}`, { x: c.x + dx * r, y: c.y + dy * r * (w / h), cx: c.x, cy: c.y });
      } else if (c.type === 'button' && c.key && held.has(c.key)) {
        want.set(`b${i}`, { x: c.x, y: c.y });
      }
    });
    return want;
  }
  /** Bring the device's fingers in line with the held keys. */
  function sync() {
    if (!active()) {
      held.clear();
      liftAll();
      return;
    }
    const want = desired();
    for (const k of [...fingers.keys()]) if (k[0] !== 'l' && !want.has(k)) lift(k);
    for (const [k, p] of want) {
      let f = fingers.get(k);
      if (!f) {
        const id = freeId();
        if (id < 0) continue;
        if (p.cx !== undefined) {
          // Joystick: press at its centre, then (a couple of frames later, so the game sees the
          // press before the drag; Roblox's dynamic thumbstick needs that) slide to the direction.
          f = { id, x: p.cx, y: p.cy, ready: false };
          fingers.set(k, f);
          touchAt(0, f);
          f.timer = setTimeout(() => { f.ready = true; if (fingers.get(k) === f) sync(); }, 34);
          continue;
        }
        f = { id, x: p.x, y: p.y, ready: true };
        fingers.set(k, f);
        touchAt(0, f);
        continue;
      }
      if (!f.ready) continue;
      if (f.x !== p.x || f.y !== p.y) {
        // Big jumps (a full reversal) go via an intermediate point, so the game sees a drag.
        if (Math.hypot(f.x - p.x, f.y - p.y) > 0.12) { f.x = (f.x + p.x) / 2; f.y = (f.y + p.y) / 2; touchAt(2, f); }
        f.x = p.x; f.y = p.y;
        touchAt(2, f);
      }
    }
  }

  // ---- state changes ----
  function refresh() {
    const a = active();
    if (!a) { held.clear(); liftAll(); if (locked()) unlock(); }
    if (a && !wasActive) { armed = true; showLabels(4500); }
    if (!a && wasActive) hideLabels();
    wasActive = a;
    if (a) sync(); else renderLabels();
  }
  function unlock() { selfUnlock = true; try { document.exitPointerLock(); } catch { /* ignore */ } }
  const canLock = () => typeof canvas.requestPointerLock === 'function';
  // Refused (Chrome blocks a re-lock ~1 s after Esc, iframes without allow-pointer-lock, ...):
  // clicks tap the screen instead of doing nothing at all.
  function lockFailed() {
    if (locked()) return;
    armed = false;
    if (active()) tip(`Could not capture the mouse: clicks tap the screen · press <kbd>${keyLabel(AIM_KEY)}</kbd> to try again`, 4000);
  }
  function lockMouse() {
    if (!lookC || locked() || !canLock()) return;
    try {
      const r = canvas.requestPointerLock({ unadjustedMovement: true });
      r?.catch?.(() => { try { canvas.requestPointerLock()?.catch?.(lockFailed); } catch { lockFailed(); } });
    } catch { try { canvas.requestPointerLock(); } catch { lockFailed(); } }
  }

  // ---- keys (called by stream.js before its own handling; true = consumed) ----
  function keyDown(e) {
    const code = e.code;
    if (suspended) {
      // Chat mode: keys type normally. Enter (sends the message) or Esc ends it; the key still goes through.
      if (code === CHAT_KEY || code === 'Escape') { suspended = false; tip(''); queueMicrotask(refresh); }
      return false;
    }
    if (!active()) return false;
    if (code === 'Escape' && (locked() || performance.now() < escUntil)) { e.preventDefault(); return true; }   // it freed the mouse
    if (binds.has(code)) {
      // A mapped key never reaches the device as a key, with any modifier (Alt+W would have typed W).
      // Alt itself may be bound (e.altKey is true on its own keydown); Meta combos are OS shortcuts: swallow, no press.
      e.preventDefault();
      if (e.repeat || held.has(code) || (e.metaKey && !/^(Meta|OS)/.test(code))) return true;
      held.add(code);
      sync();
      return true;
    }
    if (code === CHAT_KEY) {
      e.preventDefault();
      if (e.repeat) return true;
      suspended = true;
      held.clear(); liftAll();
      if (locked()) unlock();
      tip('Typing: keys go to the game as text · <kbd>Enter</kbd> sends, <kbd>Esc</kbd> cancels');
      return true;
    }
    if (e.metaKey || e.altKey) return false;
    if (code === 'Slash') {
      // Roblox (and others) open chat with "/": let it through and pause mapping until Enter/Esc.
      if (e.repeat) return false;
      suspended = true;
      held.clear(); liftAll();
      if (locked()) unlock();
      tip('Typing: keys go to the game as text · <kbd>Enter</kbd> sends, <kbd>Esc</kbd> cancels');
      return false;
    }
    if (code === PEEK_KEY) {
      e.preventDefault();
      if (!e.repeat) { peek = true; showLabels(0); }
      return true;
    }
    if (code === AIM_KEY && lookC) {
      e.preventDefault();
      if (e.repeat) return true;
      if (locked()) { armed = false; unlock(); } else { armed = true; lockMouse(); }
      return true;
    }
    return false;
  }
  function keyUp(e) {
    if (e.code === PEEK_KEY && peek) { peek = false; hideLabels(900); return true; }
    if (!held.has(e.code)) return false;
    e.preventDefault();
    held.delete(e.code);
    sync();
    return true;
  }

  // ---- mouse ----
  /** stream.js pointerdown: true = not a touch (it locks the mouse, or the mouse is locked). */
  // No preventDefault here: cancelling pointerdown stops the browser firing mousedown/mousemove/mouseup
  // until the button is up, which would kill mapped clicks (Fire) and mouse look while a button is held.
  function pointerDown(e) {
    if (locked()) return true;
    if (e.pointerType !== 'mouse' || e.button !== 0 || !active() || !lookC || !armed || !canLock()) return false;
    canvas.focus();
    lockMouse();
    return true;
  }
  const mouseCode = e => `Mouse${e.button}`;
  on(canvas, 'mousedown', e => {
    if (!locked() || !active()) return;
    e.preventDefault();
    const code = mouseCode(e);
    if (binds.has(code) && !held.has(code)) { held.add(code); sync(); }
  });
  on(document, 'mouseup', e => {
    const code = mouseCode(e);
    if (held.has(code)) { held.delete(code); sync(); }
  });
  on(document, 'mousemove', e => {
    if (!locked() || !active() || !lookC) return;
    lookAcc[0] += e.movementX || 0;
    lookAcc[1] += e.movementY || 0;
    if (!lookRaf) lookRaf = requestAnimationFrame(flushLook);
  });
  // One finger drag per frame (at most ~60-120 touch moves a second): no rAF while the mouse is still.
  function flushLook() {
    lookRaf = 0;
    if (!locked() || !active() || !lookC) return;
    const [w, h] = size();
    if (!w) return;
    const k = 0.6 * (lookC.sens || 1);
    const dx = (lookAcc[0] * k) / w, dy = (lookAcc[1] * k) / h;
    lookAcc[0] = lookAcc[1] = 0;
    const x0 = lookC.x - lookC.w / 2, x1 = lookC.x + lookC.w / 2, y0 = lookC.y - lookC.h / 2, y1 = lookC.y + lookC.h / 2;
    let f = fingers.get('l');
    if (!f) {
      const id = freeId();
      if (id < 0) return;
      f = { id, x: lookC.x, y: lookC.y, ready: true };
      fingers.set('l', f);
      touchAt(0, f);
      lookAcc[0] = dx * w / k; lookAcc[1] = dy * h / k;   // apply this motion next frame, after the press
      lookRaf = requestAnimationFrame(flushLook);
    } else {
      const nx = f.x + dx, ny = f.y + dy;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) {
        // Out of room: lift and press again at the centre (games read this as a new drag).
        lift('l');
        lookAcc[0] = dx * w / k; lookAcc[1] = dy * h / k;
        lookRaf = requestAnimationFrame(flushLook);
        return;
      }
      f.x = nx; f.y = ny;
      touchAt(2, f);
    }
    clearTimeout(lookIdle);
    lookIdle = setTimeout(() => lift('l'), 400);   // still mouse: let go
  }
  on(document, 'pointerlockchange', () => {
    if (locked()) { tip(''); return; }
    lift('l');
    for (const c of ['Mouse0', 'Mouse1', 'Mouse2']) held.delete(c);
    if (active()) sync();
    if (!selfUnlock && active()) {
      armed = false;
      escUntil = performance.now() + 600;
      tip(`Mouse freed: clicks tap the screen · press <kbd>${keyLabel(AIM_KEY)}</kbd> to aim again`, 4000);
    }
    selfUnlock = false;
  });

  // ---- labels and tips (DOM over the stream; timers only, no animation loop) ----
  let labelTimer = 0, tipTimer = 0, tipEl = null, labelsEl = null;
  if (layer) {
    layer.replaceChildren();
    labelsEl = document.createElement('div');
    labelsEl.className = 'km-labels';
    tipEl = document.createElement('div');
    tipEl.className = 'km-tip';
    layer.append(labelsEl, tipEl);
  }
  function tip(html, ms = 0) {
    if (!tipEl) return;
    clearTimeout(tipTimer);
    tipEl.innerHTML = html;
    tipEl.classList.toggle('show', !!html);
    if (html && ms) tipTimer = setTimeout(() => tipEl.classList.remove('show'), ms);
  }
  function renderLabels() {
    if (!labelsEl) return;
    if (!active() || !profile) { labelsEl.replaceChildren(); return; }
    const r = canvas.getBoundingClientRect(), pr = layer.getBoundingClientRect();
    const L = x => r.left - pr.left + x * r.width, T = y => r.top - pr.top + y * r.height;
    let html = '';
    for (const c of profile.controls) {
      if (c.type === 'stick') {
        const d = c.r * r.width * 2;
        html += `<div class="km-l-stick" style="left:${L(c.x)}px;top:${T(c.y)}px;width:${d}px;height:${d}px">`
          + `<kbd class="u">${esc(keyLabel(c.up))}</kbd><kbd class="l">${esc(keyLabel(c.left))}</kbd><kbd class="d">${esc(keyLabel(c.down))}</kbd><kbd class="r">${esc(keyLabel(c.right))}</kbd></div>`;
      } else if (c.type === 'button' && c.key) {
        const d = c.s ? Math.max(18, c.s * r.width) : 0;   // its own size, else the default look
        html += `<kbd class="km-l-btn${d ? ' sized' : ''}" style="left:${L(c.x)}px;top:${T(c.y)}px${d ? `;width:${d}px;height:${d}px` : ''}">${esc(keyLabel(c.key))}</kbd>`;
      } else if (c.type === 'look') {
        html += `<div class="km-l-look" style="left:${L(c.x - c.w / 2)}px;top:${T(c.y - c.h / 2)}px;width:${c.w * r.width}px;height:${c.h * r.height}px"><span>Mouse look · click to aim</span></div>`;
      }
    }
    labelsEl.innerHTML = html;
  }
  function showLabels(ms) {
    if (!labelsEl || (!labelsOn && !peek)) return;
    renderLabels();
    clearTimeout(labelTimer);
    labelsEl.classList.add('show');
    if (ms) labelTimer = setTimeout(() => labelsEl.classList.remove('show'), ms);
  }
  function hideLabels(ms = 0) {
    if (!labelsEl) return;
    clearTimeout(labelTimer);
    if (ms) labelTimer = setTimeout(() => labelsEl.classList.remove('show'), ms);
    else labelsEl.classList.remove('show');
  }
  on(window, 'resize', () => { if (labelsEl?.classList.contains('show')) renderLabels(); });

  return {
    get active() { return active(); },
    get locked() { return locked(); },
    get enabled() { return enabled; },
    get profile() { return profile; },
    get labels() { return labelsOn; },
    setProfile(p) { held.clear(); liftAll(); profile = p ? sanitizeProfile(p) : null; rebuild(); wasActive = false; refresh(); },
    setEnabled(v) { enabled = !!v; suspended = false; tip(''); refresh(); },
    setEditing(v) { editing = !!v; refresh(); },
    setLabels(v) { labelsOn = !!v; localStorage.setItem('rose-km-labels', labelsOn ? '1' : '0'); if (labelsOn) showLabels(4500); else hideLabels(); },
    /** Video size changed (rotation): old fingers are void; press again at the new size if still held. */
    onSize() {
      liftAll();
      // An up sent between the device rotating and the first new-size frame carried the old size and
      // scrcpy dropped it: that finger is still down on the device. Lift recent ones again (harmless if not).
      const t = performance.now(), live = new Set([...fingers.values()].map(f => f.id));
      for (const u of recentUps) if (t - u.t < 1500 && !live.has(u.id)) touchAt(1, u);
      recentUps = [];
      refresh();
      if (labelsEl?.classList.contains('show')) renderLabels();
    },
    /** Let go of everything (blur, menu, hidden page, Type text). */
    releaseAll() { held.clear(); liftAll(); suspended = false; tip(''); if (locked()) unlock(); },
    keyDown, keyUp, pointerDown,
    destroy() {
      held.clear(); liftAll();
      cancelAnimationFrame(lookRaf); clearTimeout(lookIdle); clearTimeout(labelTimer); clearTimeout(tipTimer);
      if (locked()) unlock();
      layer?.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------- editor
/**
 * Full-screen layout editor over the stream. Resolves nothing; calls back.
 * @param {object} o
 * @param {HTMLElement} o.root          #player
 * @param {HTMLCanvasElement} o.canvas
 * @param {string} o.title
 * @param {object} o.profile            what the player uses now
 * @param {object} o.base               what "Reset" goes back to (server or shipped default)
 * @param {(p: object|null) => void} o.onSave       null = no own layout (back to the default)
 * @param {(p: object) => Promise<void>} o.onSaveGlobal
 * @param {() => void} o.onClose
 */
export function openEditor({ root, canvas, title, profile, base, onSave, onSaveGlobal, onClose }) {
  let work = clone(sanitizeProfile(profile) || GENERIC), binding = null, sel = -1;
  // Saving an untouched default must not store a copy (it would shadow later "for everyone" layouts).
  let isDefault = JSON.stringify(work) === JSON.stringify(sanitizeProfile(base) || GENERIC);
  const el = document.createElement('div');
  el.className = 'km-edit';
  el.innerHTML = `<div class="km-stage"></div>
    <div class="km-bar" role="toolbar">
      <div class="km-bar-title"><b>Edit controls</b><span>${esc(title)}</span></div>
      <div class="km-bar-tools">
        <button class="btn btn-glass btn-sm" data-add="button">+ Button</button>
        <button class="btn btn-glass btn-sm" data-add="stick">+ Joystick</button>
        <button class="btn btn-glass btn-sm" data-add="look">+ Mouse look</button>
        <span class="km-scale" role="group" aria-label="Size of all controls"><span>All sizes</span><button class="btn btn-ghost btn-sm" data-scale="down" title="Make every control smaller (−)" aria-label="Smaller">−</button><button class="btn btn-ghost btn-sm" data-scale="up" title="Make every control bigger (+)" aria-label="Bigger">+</button></span>
        <button class="btn btn-ghost btn-sm" data-act="reset">Reset to default</button>
      </div>
      <div class="km-bar-tools">
        <button class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button>
        <button class="btn btn-glass btn-sm" data-act="global" title="Needs the upload password">Save for everyone</button>
        <button class="btn btn-play btn-sm" data-act="save">Save</button>
      </div>
    </div>
    <div class="km-note"></div>
    <div class="km-pop" hidden></div>`;
  root.append(el);
  const stage = el.querySelector('.km-stage'), pop = el.querySelector('.km-pop'), note = el.querySelector('.km-note');

  function box() {
    const r = canvas.getBoundingClientRect(), pr = root.getBoundingClientRect();
    if (canvas.width > canvas.height && r.width > 0) {
      note.textContent = 'Drag to move · scroll over a control (or drag its white dot) to resize · click it to change its key';
      return { left: r.left - pr.left, top: r.top - pr.top, width: r.width, height: r.height };
    }
    // Portrait right now: edit on a landscape frame the size of the window.
    note.textContent = 'The game is in portrait right now. These positions apply once it turns landscape.';
    const s = Math.min(pr.width / 16, pr.height / 9);
    return { left: (pr.width - 16 * s) / 2, top: (pr.height - 9 * s) / 2, width: 16 * s, height: 9 * s };
  }
  let B = box();
  // A button without a size of its own is drawn 48 px wide here: that as a fraction of the frame.
  const btnSize = () => 48 / (B.width || 1280);
  // One marker's position, size and labels.
  function place(m, c) {
    if (c.type === 'stick') {
      const d = c.r * B.width * 2;
      Object.assign(m.style, { left: `${c.x * B.width}px`, top: `${c.y * B.height}px`, width: `${d}px`, height: `${d}px` });
      m.innerHTML = `<kbd class="u">${esc(keyLabel(c.up))}</kbd><kbd class="l">${esc(keyLabel(c.left))}</kbd><kbd class="d">${esc(keyLabel(c.down))}</kbd><kbd class="r">${esc(keyLabel(c.right))}</kbd><i class="km-h" title="Drag to resize"></i>`;
    } else if (c.type === 'button') {
      const d = c.s ? Math.max(24, c.s * B.width) : 0;
      Object.assign(m.style, { left: `${c.x * B.width}px`, top: `${c.y * B.height}px`, width: d ? `${d}px` : '', height: d ? `${d}px` : '' });
      m.classList.toggle('sized', !!d);
      m.innerHTML = `<b>${esc(keyLabel(c.key))}</b>${c.name && (!d || d >= 44) ? `<span>${esc(c.name)}</span>` : ''}<i class="km-h" title="Drag to resize"></i>`;
    } else {
      Object.assign(m.style, { left: `${(c.x - c.w / 2) * B.width}px`, top: `${(c.y - c.h / 2) * B.height}px`, width: `${c.w * B.width}px`, height: `${c.h * B.height}px` });
      m.innerHTML = '<span>Mouse look</span><i class="km-h" title="Drag to resize"></i>';
    }
  }
  function render() {
    B = box();
    Object.assign(stage.style, { left: `${B.left}px`, top: `${B.top}px`, width: `${B.width}px`, height: `${B.height}px` });
    stage.replaceChildren();
    work.controls.forEach((c, i) => {
      const m = document.createElement('div');
      m.dataset.i = i;
      m.className = `km-mk km-${c.type}${i === sel ? ' sel' : ''}`;
      place(m, c);
      stage.append(m);
    });
    el.querySelector('[data-add="stick"]').hidden = work.controls.filter(c => c.type === 'stick').length >= 2;
    el.querySelector('[data-add="look"]').hidden = work.controls.some(c => c.type === 'look');
  }
  const changed = () => { isDefault = false; render(); };

  // Drag a marker (or its resize handle); a click without movement opens its settings.
  stage.addEventListener('pointerdown', e => {
    const m = e.target.closest('.km-mk');
    if (!m) { closePop(); return; }
    e.preventDefault();
    const i = +m.dataset.i, c = work.controls[i], handle = e.target.classList.contains('km-h');
    const start = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y };
    let moved = false;
    m.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - start.x) / B.width, dy = (ev.clientY - start.y) / B.height;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      moved = true;
      const cl = v => Math.max(0, Math.min(1, v));
      if (handle && c.type === 'stick') {
        const px = (ev.clientX - (B.left + root.getBoundingClientRect().left)) / B.width - c.x;
        const py = ((ev.clientY - (B.top + root.getBoundingClientRect().top)) / B.height - c.y) * (B.height / B.width);
        c.r = clampSize(c, Math.hypot(px, py));
      } else if (handle && c.type === 'button') {
        // The dot sits on its corner and follows the pointer.
        const px = (ev.clientX - (B.left + root.getBoundingClientRect().left)) / B.width - c.x;
        const py = ((ev.clientY - (B.top + root.getBoundingClientRect().top)) / B.height - c.y) * (B.height / B.width);
        c.s = clampSize(c, 2 * Math.max(Math.abs(px), Math.abs(py)));
      } else if (handle && c.type === 'look') {
        const px = (ev.clientX - (B.left + root.getBoundingClientRect().left)) / B.width;
        const py = (ev.clientY - (B.top + root.getBoundingClientRect().top)) / B.height;
        c.w = Math.max(0.08, Math.min(1, 2 * Math.abs(px - c.x)));
        c.h = Math.max(0.08, Math.min(1, 2 * Math.abs(py - c.y)));
      } else {
        c.x = Math.round(cl(start.cx + dx) * 1000) / 1000;
        c.y = Math.round(cl(start.cy + dy) * 1000) / 1000;
      }
      isDefault = false;
      place(m, c);
      if (handle && sel === i) syncSize();
    };
    const up = () => {
      m.removeEventListener('pointermove', move);
      m.removeEventListener('pointerup', up);
      m.removeEventListener('pointercancel', up);
      if (!moved) openPop(i);
      else if (sel === i) placePop();
    };
    m.addEventListener('pointermove', move);
    m.addEventListener('pointerup', up);
    m.addEventListener('pointercancel', up);
  });
  // Scroll over a control to resize it (Shift: finer steps).
  stage.addEventListener('wheel', e => {
    const m = e.target.closest('.km-mk');
    if (!m) return;
    e.preventDefault();
    const d = e.deltaY || e.deltaX;   // Shift+wheel scrolls sideways in some browsers
    if (!d) return;
    const i = +m.dataset.i, c = work.controls[i], step = e.shiftKey ? 1.02 : 1.08;
    scaleControl(c, d < 0 ? step : 1 / step, btnSize());
    isDefault = false;
    place(m, c);
    if (sel === i) { syncSize(); placePop(); }
  }, { passive: false });
  /** Every control a step bigger (f > 1) or smaller; positions stay. */
  function scaleAll(f) {
    for (const c of work.controls) scaleControl(c, f, btnSize());
    isDefault = false;
    render();
    syncSize();
    placePop();
  }

  // Size sliders, in % of the frame width (a joystick: its diameter; mouse look: each side).
  const SLIDERS = { stick: [['r', 'Size', 2]], button: [['s', 'Size', 1]], look: [['w', 'Width', 1], ['h', 'Height', 1]] };
  const sizeOf = (c, f) => c[f] || (f === 's' ? btnSize() : 0);
  function sizeRows(c) {
    const [lo, hi] = SIZE[c.type];
    return SLIDERS[c.type].map(([f, label, k]) => {
      const v = sizeOf(c, f) * k * 100;
      return `<div class="km-row"><span>${label}</span><input type="range" class="km-sz" data-f="${f}" data-k="${k}" min="${lo * k * 100}" max="${hi * k * 100}" step="0.5" value="${v.toFixed(1)}" aria-label="${label}"><b class="km-sz-v">${Math.round(v)}%</b></div>`;
    }).join('');
  }
  /** The open settings follow a size changed some other way (drag, scroll, All sizes, + / −). */
  function syncSize() {
    const c = work.controls[sel];
    if (!c || pop.hidden) return;
    for (const inp of pop.querySelectorAll('.km-sz')) {
      const v = sizeOf(c, inp.dataset.f) * Number(inp.dataset.k) * 100;
      inp.value = v.toFixed(1);
      inp.nextElementSibling.textContent = `${Math.round(v)}%`;
    }
  }

  function slot(field, label) {
    const c = work.controls[sel];
    const waiting = binding?.field === field;
    return `<div class="km-row"><span>${esc(label)}</span><button class="km-key${waiting ? ' wait' : ''}" data-bind="${field}">${waiting ? 'Press a key…' : esc(keyLabel(c[field]))}</button></div>`;
  }
  function openPop(i) { sel = i; binding = null; render(); fillPop(); }
  function closePop() { sel = -1; binding = null; pop.hidden = true; render(); }
  function fillPop() {
    const c = work.controls[sel];
    if (!c) { pop.hidden = true; return; }
    let html = '';
    if (c.type === 'button') {
      html = `<div class="km-pop-h">Button</div>${slot('key', 'Key')}
        <div class="km-row"><span>Or</span><span class="km-chips"><button data-mouse="Mouse0">Left click</button><button data-mouse="Mouse2">Right click</button></span></div>
        <div class="km-row"><span>Name</span><input class="input km-name" maxlength="24" value="${esc(c.name || '')}" placeholder="e.g. Jump"></div>
        ${sizeRows(c)}
        <p class="km-fine">Size only changes how it looks: the key taps its centre, so put that on the game's button.</p>`;
    } else if (c.type === 'stick') {
      html = `<div class="km-pop-h">Joystick</div>${slot('up', 'Up')}${slot('left', 'Left')}${slot('down', 'Down')}${slot('right', 'Right')}${slot('mod', 'Walk (hold)')}
        ${sizeRows(c)}
        <p class="km-fine">Size is how far the keys slide your finger: match the game's joystick, or your character won't reach full speed.</p>`;
    } else {
      html = `<div class="km-pop-h">Mouse look</div>
        <div class="km-row"><span>Sensitivity</span><input type="range" class="km-sens" min="0.2" max="4" step="0.1" value="${c.sens}"><b class="km-sens-v">${c.sens.toFixed(1)}</b></div>
        ${sizeRows(c)}
        <p class="km-fine">Click the game to aim with the mouse; Esc frees the cursor; <kbd>\`</kbd> aims again. Left/right click press the buttons bound to them.</p>`;
    }
    html += `<p class="km-fine">Scroll over a control, or press <kbd>+</kbd> / <kbd>−</kbd>, to resize it.</p>`;
    html += `<div class="km-pop-foot"><button class="btn btn-ghost btn-sm btn-danger-text" data-del>Remove</button><button class="btn btn-glass btn-sm" data-done>Done</button></div>`;
    pop.innerHTML = html;
    pop.hidden = false;
    placePop();
  }
  function placePop() {
    const c = work.controls[sel];
    if (!c || pop.hidden) return;
    const pr = root.getBoundingClientRect();
    const px = B.left + c.x * B.width, py = B.top + c.y * B.height;
    const w = pop.offsetWidth || 280, h = pop.offsetHeight || 200;
    let left = px + 40, top = py - h / 2;
    if (left + w > pr.width - 12) left = px - 40 - w;
    left = Math.max(12, Math.min(pr.width - w - 12, left));
    top = Math.max(12, Math.min(pr.height - h - 12, top));
    Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
  }
  pop.addEventListener('click', e => {
    const c = work.controls[sel];
    if (!c) return;
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.bind) { binding = { field: t.dataset.bind }; fillPop(); }
    else if (t.dataset.mouse) { c.key = t.dataset.mouse; binding = null; changed(); fillPop(); }
    else if (t.hasAttribute('data-del')) { work.controls.splice(sel, 1); isDefault = false; closePop(); }
    else if (t.hasAttribute('data-done')) closePop();
  });
  pop.addEventListener('input', e => {
    const c = work.controls[sel];
    if (!c) return;
    if (e.target.classList.contains('km-sens')) { c.sens = Number(e.target.value); pop.querySelector('.km-sens-v').textContent = c.sens.toFixed(1); isDefault = false; }
    if (e.target.classList.contains('km-sz')) {
      const { f, k } = e.target.dataset;
      c[f] = clampSize(c, Number(e.target.value) / (Number(k) * 100));
      e.target.nextElementSibling.textContent = `${Math.round(Number(e.target.value))}%`;
      isDefault = false;
      const m = stage.querySelector(`.km-mk[data-i="${sel}"]`);
      if (m) place(m, c);
      placePop();
    }
    if (e.target.classList.contains('km-name')) { c.name = e.target.value.slice(0, 24); isDefault = false; render(); }
  });

  // Key capture while the editor is open: binding, or Escape to close. Nothing reaches the game.
  const onKey = e => {
    if (e.target.closest?.('.km-name')) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.target.blur(); } e.stopImmediatePropagation(); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    // + / −: resize the selected control, or every control when none is selected (held: repeats).
    const grow = e.code === 'Equal' || e.code === 'NumpadAdd', shrink = e.code === 'Minus' || e.code === 'NumpadSubtract';
    if (!binding && (grow || shrink)) {
      if (sel >= 0) { scaleControl(work.controls[sel], grow ? 1.08 : 1 / 1.08, btnSize()); isDefault = false; render(); syncSize(); placePop(); }
      else scaleAll(grow ? 1.1 : 1 / 1.1);
      return;
    }
    if (e.repeat) return;
    if (binding) {
      const c = work.controls[sel];
      if (e.code === 'Escape') binding = null;
      else if (e.code === 'Backspace' || e.code === 'Delete') { c[binding.field] = ''; binding = null; changed(); }
      else if (/^[A-Za-z0-9]{1,24}$/.test(e.code) && !e.metaKey) { c[binding.field] = e.code; binding = null; changed(); }
      fillPop();
      return;
    }
    if (e.code === 'Escape') { if (sel >= 0) closePop(); else close(); }
  };
  addEventListener('keydown', onKey, { capture: true });
  addEventListener('keyup', onKey, { capture: true });
  const onResize = () => { render(); placePop(); };
  addEventListener('resize', onResize);

  el.querySelector('.km-bar').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.scale) { scaleAll(b.dataset.scale === 'up' ? 1.1 : 1 / 1.1); return; }
    if (b.dataset.add) {
      const c = b.dataset.add === 'button' ? btn('', 0.75, 0.5, '') : b.dataset.add === 'stick' ? stick(0.3, 0.7, 0.1) : look(0.6, 0.4, 0.4, 0.5);
      if (c.type === 'stick' && work.controls.some(x => x.type === 'stick')) Object.assign(c, { x: 0.82, y: 0.7, up: 'ArrowUp', left: 'ArrowLeft', down: 'ArrowDown', right: 'ArrowRight' });
      work.controls.push(c);
      isDefault = false;
      openPop(work.controls.length - 1);
      if (c.type === 'button') { binding = { field: 'key' }; fillPop(); }
    } else if (b.dataset.act === 'reset') {
      work = clone(sanitizeProfile(base) || GENERIC); isDefault = true; closePop();
    } else if (b.dataset.act === 'cancel') close();
    else if (b.dataset.act === 'save') { onSave(isDefault ? null : sanitizeProfile(work)); close(); }
    else if (b.dataset.act === 'global') {
      b.disabled = true;
      try { await onSaveGlobal(sanitizeProfile(work)); close(); } catch { /* the caller showed the error */ } finally { b.disabled = false; }
    }
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    removeEventListener('keydown', onKey, { capture: true });
    removeEventListener('keyup', onKey, { capture: true });
    removeEventListener('resize', onResize);
    el.remove();
    onClose?.();
  }
  render();
  return { close };
}
