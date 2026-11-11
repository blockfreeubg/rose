// Streaming engine: WebSocket H.264 -> WebCodecs -> canvas, plus touch/mouse/keyboard/gamepad input.
import { wsProtocols } from './auth.js';
// UI-agnostic: app.js drives it through the returned handle.
import { createKeymapper } from './keymap.js';

const KEYMAP = {
  Enter: 66, Backspace: 67, Space: 62, Tab: 61, Escape: 111, Delete: 112,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  ShiftLeft: 59, ShiftRight: 60, ControlLeft: 113, ControlRight: 114, AltLeft: 57, AltRight: 58,
  Comma: 55, Period: 56, Minus: 69, Equal: 70, BracketLeft: 71, BracketRight: 72,
  Backslash: 73, Semicolon: 74, Quote: 75, Slash: 76, Backquote: 68,
  PageUp: 92, PageDown: 93, Home: 122, End: 123,
};
for (let i = 0; i < 26; i++) KEYMAP['Key' + String.fromCharCode(65 + i)] = 29 + i;
for (let i = 0; i < 10; i++) KEYMAP['Digit' + i] = 7 + i;
for (let i = 1; i <= 12; i++) KEYMAP['F' + i] = 130 + i;

// ---- controllers ----
// Each browser gamepad (and, for console games, the keyboard) becomes a virtual controller on the
// device; the server turns these states into a real Android gamepad (server/gamepad.js).
const B = {
  SOUTH: 1, EAST: 2, WEST: 8, NORTH: 16, L1: 64, R1: 128, SELECT: 1024, START: 2048, MODE: 4096,
  L3: 8192, R3: 16384, UP: 1 << 16, DOWN: 1 << 17, LEFT: 1 << 18, RIGHT: 1 << 19,
};
// Browser "standard" gamepad layout, by button index (6 and 7 are the analog triggers).
const STANDARD = [B.SOUTH, B.EAST, B.WEST, B.NORTH, B.L1, B.R1, 0, 0, B.SELECT, B.START, B.L3, B.R3, B.UP, B.DOWN, B.LEFT, B.RIGHT, B.MODE];
// Pads the browser can't remap (mapping '') list raw evdev buttons/axes; this is the usual Linux
// order for XInput-style pads (BTN_A, B, X, Y, TL, TR, SELECT, START, MODE, THUMBL, THUMBR).
const RAW = [B.SOUTH, B.EAST, B.WEST, B.NORTH, B.L1, B.R1, B.SELECT, B.START, B.MODE, B.L3, B.R3];
// Keyboard as controller 1, labeled like a Switch (A right, B bottom, X top, Y left; Eden maps
// buttons by position for this virtual pad). Same defaults as popular desktop emulators.
const KEYPAD = {
  KeyZ: { b: B.EAST }, KeyX: { b: B.SOUTH }, KeyC: { b: B.NORTH }, KeyV: { b: B.WEST },
  KeyE: { b: B.L1 }, KeyQ: { lt: 1 }, KeyU: { b: B.R1 }, KeyO: { rt: 1 },
  Enter: { b: B.START }, Equal: { b: B.START }, Minus: { b: B.SELECT },
  KeyF: { b: B.L3 }, KeyH: { b: B.R3 },
  ArrowUp: { b: B.UP }, ArrowDown: { b: B.DOWN }, ArrowLeft: { b: B.LEFT }, ArrowRight: { b: B.RIGHT },
  KeyW: { ly: -1 }, KeyS: { ly: 1 }, KeyA: { lx: -1 }, KeyD: { lx: 1 },
  KeyI: { ry: -1 }, KeyK: { ry: 1 }, KeyJ: { rx: -1 }, KeyL: { rx: 1 },
};
/** Keyboard-as-controller layout, for the in-game legend. */
export const KEYPAD_LEGEND = [
  ['W A S D', 'Left stick'], ['I J K L', 'Right stick'], ['Arrow keys', 'D-pad'],
  ['Z', 'A'], ['X', 'B'], ['C', 'X'], ['V', 'Y'],
  ['Q / E', 'ZL / L'], ['U / O', 'R / ZR'], ['Enter', '+'], ['−', '−'], ['F / H', 'Stick clicks'],
];
const NEUTRAL = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
const r2 = v => Math.round(v * 100) / 100;
const deadzone = v => (Math.abs(v) < 0.12 ? 0 : r2(Math.max(-1, Math.min(1, v))));

// Build "avc1.PPCCLL" from the SPS inside an Annex-B config packet.
function codecFromConfig(buf) {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && (buf[i + 3] & 0x1f) === 7) {
      const hex = n => n.toString(16).padStart(2, '0');
      return `avc1.${hex(buf[i + 4])}${hex(buf[i + 5])}${hex(buf[i + 6])}`;
    }
  }
  return 'avc1.42E01F';
}

// ---- audio ----
// The server relays scrcpy's Opus stream as kinds 3 (config: the OpusHead) and 4 (one 20 ms frame),
// only to viewers that asked with {t:'audio', on:true} (older pages would feed them to the video
// decoder). Decoded with WebCodecs, played through a jitter buffer in audio-worklet.js, then
// makeup gain (games mix quietly) into a limiter. One AudioContext is shared by every stream: it
// has to be created inside a user gesture (unlockAudio() at the top of play()).
// Browsers without WebCodecs audio/Opus get no audio controls (no WASM decoder in this version).
// Nothing here may break video, input or the launch: every failure just turns audio off.
const OPUS = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
// The OpusHead scrcpy sends (version 1, stereo, pre-skip 312, 48 kHz), for the support check.
const OPUS_HEAD = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0]);
const MAKEUP = 4;                 // about +12 dB at 100 % volume; the limiter catches the peaks
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode / quota */ } };
const clamp01 = v => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);
const A = {
  ctx: null, node: null, gain: null, broken: false, paused: false, support: null,
  muted: lsGet('rose-muted') === '1',
  volume: clamp01(parseFloat(lsGet('rose-volume') ?? '1')),
};
const audioPossible = () => !A.broken && typeof AudioDecoder === 'function' && typeof EncodedAudioChunk === 'function'
  && typeof AudioWorkletNode === 'function' && typeof AudioContext === 'function' && window.isSecureContext;
function audioBroke(why, err) {
  if (!A.broken) console.warn(`audio disabled: ${why}`, err || '');
  A.broken = true;
  try { A.node?.disconnect(); } catch { /* ignore */ }
  A.node = null;
}

/** Resolves true when this browser can play Rose audio (WebCodecs Opus + AudioWorklet). */
export function audioSupported() {
  A.support ??= (async () => {
    try {
      if (!audioPossible()) return false;
      return !!(await AudioDecoder.isConfigSupported({ ...OPUS, description: OPUS_HEAD })).supported;
    } catch { return false; }
  })();
  return A.support.then(ok => ok && !A.broken);
}

/**
 * Create (first call) or resume the shared AudioContext. Call it synchronously inside a user
 * gesture, before any await: Safari only unlocks audio there.
 */
export function unlockAudio() {
  try {
    if (!audioPossible()) return;
    if (!A.ctx) {
      // 48 kHz (Opus's rate) when the browser allows it; otherwise its own rate, and pushAudio() resamples.
      let ctx;
      try { ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 }); } catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
      if (ctx.sampleRate !== 48000) console.info(`audio: output at ${ctx.sampleRate} Hz, resampling from 48 kHz`);
      A.ctx = ctx;
      // iOS: play even with the ringer switch on silent (Safari 17+; elsewhere a no-op).
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* ignore */ }
      // iOS 'interrupted' (a call, Siri) and autoplay suspension: resume as soon as allowed, unless
      // we suspended it ourselves for a hidden page.
      ctx.onstatechange = () => {
        if (ctx.state !== 'running' && ctx.state !== 'closed' && !A.paused && !document.hidden) ctx.resume().catch(() => {});
      };
      ctx.audioWorklet.addModule(new URL('audio-worklet.js', import.meta.url).href).then(() => {
        if (A.broken) return;
        const node = new AudioWorkletNode(ctx, 'rose-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        node.onprocessorerror = e => audioBroke('worklet crashed', e);
        const gain = ctx.createGain();
        const lim = ctx.createDynamicsCompressor();
        lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.1;
        node.connect(gain).connect(lim).connect(ctx.destination);
        A.node = node; A.gain = gain;
        applyGain();
      }).catch(e => audioBroke('could not load the audio worklet', e));
    }
    if (A.ctx.state !== 'running' && !document.hidden) { A.paused = false; A.ctx.resume().catch(() => {}); }
  } catch (e) { audioBroke('could not create an AudioContext', e); }
}

function applyGain() {
  try {
    if (!A.gain) return;
    const g = A.muted ? 0 : MAKEUP * A.volume;
    A.gain.gain.setTargetAtTime(g, A.ctx.currentTime, 0.015);   // ~50 ms ramp: no click
  } catch { /* ignore */ }
}
/** Browser-side volume and mute (saved). The device volume is fixed at max by the server. */
export const audioPrefs = () => ({ muted: A.muted, volume: A.volume });
export function setAudioVolume(v) {
  A.volume = clamp01(v);
  lsSet('rose-volume', String(Math.round(A.volume * 100) / 100));
  applyGain();
}
export function setAudioMuted(m) {
  A.muted = !!m;
  lsSet('rose-muted', A.muted ? '1' : '0');
  applyGain();
}
// Linear 48 kHz -> context-rate resampler, continuous across chunks (only used when the rates differ).
const RS = { pos: 0, prev: [0, 0] };
function resample(planes, rate) {
  const step = 48000 / rate, n = planes[0].length;
  // Output sample k reads input position RS.pos + k * step; index -1 is the previous chunk's last sample.
  const count = Math.max(0, Math.ceil((n - 1 - RS.pos) / step));
  const out = planes.map((p, c) => {
    const o = new Float32Array(count), prev = RS.prev[c];
    for (let k = 0; k < count; k++) {
      const t = RS.pos + k * step, i = Math.floor(t), f = t - i;
      const a = i < 0 ? prev : p[i], b = p[i + 1];
      o[k] = a + (b - a) * f;
    }
    return o;
  });
  RS.pos += count * step - n;
  RS.prev = planes.map(p => p[n - 1]);
  return out;
}
function pushAudio(planes) {
  if (!A.node || A.ctx?.state !== 'running') return;   // nothing would play it: don't let it pile up
  if (A.ctx.sampleRate !== 48000) planes = resample(planes, A.ctx.sampleRate);
  A.node.port.postMessage({ planes }, planes.map(p => p.buffer).filter((b, i, a) => a.indexOf(b) === i));
}
function flushAudio() { RS.pos = 0; RS.prev = [0, 0]; try { A.node?.port.postMessage({ flush: true }); } catch { /* ignore */ } }
function pauseAudio() {      // page hidden: the server stops sending; drop what's queued, stop output
  flushAudio();
  if (!A.ctx) return;
  A.paused = true;
  A.ctx.suspend().catch(() => {});
}
function resumeAudio() {
  flushAudio();
  if (!A.ctx) return;
  A.paused = false;
  A.ctx.resume().catch(() => {});   // may need a gesture: canvas pointerdown/keydown retries
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {string} o.url            WebSocket URL
 * @param {() => boolean} o.inputBlocked  return true while UI overlays should swallow keys
 * @param {(e: CloseEvent) => void} o.onClose
 * @param {() => void} o.onFirstFrame
 * @param {(msg: string) => void} [o.onNotice]  one-off user-facing warnings (e.g. odd controllers)
 * @param {(state: 'restarted' | 'exited' | 'running') => void} [o.onGame]  the server's game watchdog: the game left the
 *                                  foreground and was relaunched ('restarted') or is gone for good ('exited')
 * @param {(available: boolean) => void} [o.onAudioState]  the server said this stream has no audio (false), or audio came back (true)
 * @param {boolean} [o.padKeys]     keyboard drives controller 1 (console games) instead of typing
 * @param {HTMLElement} [o.keymapLayer]  element over the stream for keyboard-to-touch labels (keymap.js)
 */
export function startStream({ canvas, url, inputBlocked, onClose, onFirstFrame, onNotice, onGame, onAudioState, padKeys = false, keymapLayer }) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const ac = new AbortController();
  const on = (target, ev, fn, opts = {}) => target.addEventListener(ev, fn, { ...opts, signal: ac.signal });
  let decoder = null, configData = null, codec = null, gotKey = false, closed = false;
  let hwDecode = true;   // hardware decoding is lightest for the player's device; see the error handler
  let videoW = 0, videoH = 0, ts = 0, firstFrame = false;
  const stats = { fps: 0, rtt: 0, kbps: 0, width: 0, height: 0, audioMs: 0 };   // audioMs 0 = no audio
  let frames = 0, bytes = 0;

  const ws = new WebSocket(url, wsProtocols());   // accounts: token as a subprotocol (auth.js), never in the URL
  ws.binaryType = 'arraybuffer';
  const send = m => { if (ws.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; };
  // Console games: create controller 1 right away, so the emulator finds it when the game boots.
  ws.addEventListener('open', () => { pollPads(); syncAudio(); });
  // Tell the server when nobody can see the stream, so it can stop sending video. Not player input.
  // On {t:'visible'} it resends the config and a keyframe. gotKey = false drops delta frames until
  // that keyframe lands (the decoder missed their references); the extra keyframe request also
  // covers a server that ignores these messages.
  // Never 'hidden' before the first frame: the server would send no video, onFirstFrame would
  // never fire and the launch would time out (players often switch tabs during a long boot).
  // The decoder output sends it once that first frame lands, if the page is still hidden.
  const sendVisibility = () => {
    if (document.hidden) {
      // The server sends no audio while hidden; drop what's queued. Its config comes again on 'visible'.
      try { resetAudioDecoder(); pauseAudio(); } catch { /* audio never breaks the stream */ }
      if (firstFrame) send({ t: 'hidden' });
      return;
    }
    try { resetAudioDecoder(); resumeAudio(); } catch { /* ignore */ }
    gotKey = false;
    send({ t: 'visible' });
    send({ t: 'keyframe' });
  };
  // (No 'hidden' on open: a fresh socket has no frame yet; see above.)

  ws.onmessage = e => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.t === 'pong') stats.rtt = performance.now() - m.ts;
      else if (m.t === 'game' && ['restarted', 'exited', 'running'].includes(m.state)) onGame?.(m.state);
      else if (m.t === 'audio' && m.available === false) setAudioAvail(false);   // this stream has no sound
      return;
    }
    bytes += e.data.byteLength;
    onPacket(new Uint8Array(e.data));
  };
  ws.onclose = e => { if (!closed) onClose?.(e); };

  function fit() {
    if (!videoW) return;
    const s = Math.min(innerWidth / videoW, innerHeight / videoH);
    canvas.style.width = `${Math.floor(videoW * s)}px`;
    canvas.style.height = `${Math.floor(videoH * s)}px`;
  }
  on(window, 'resize', fit);

  function makeDecoder() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    gotKey = false;
    decoder = new VideoDecoder({
      output: frame => {
        if (frame.displayWidth !== videoW || frame.displayHeight !== videoH) {
          videoW = canvas.width = stats.width = frame.displayWidth;
          videoH = canvas.height = stats.height = frame.displayHeight;
          fit();
          keymap.onSize();   // rotated: mapped fingers at the old size are void (scrcpy drops them)
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        frames++;
        if (!firstFrame) { firstFrame = true; onFirstFrame?.(); if (document.hidden) sendVisibility(); }
      },
      error: err => {
        console.warn('decoder error', err);
        if (closed) return;
        // 'prefer-hardware' really means hardware-only in Chrome/Brave: with no hardware H.264
        // decoder (GPU acceleration off, some Linux/VM setups) every configure fails. Fall back to
        // the software decoder once instead of retrying forever.
        if (hwDecode && /unsupported config/i.test(err.message)) { hwDecode = false; console.warn('no hardware H.264 decoder: using software decoding'); }
        makeDecoder();
        send({ t: 'keyframe' });
      },
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: hwDecode ? 'prefer-hardware' : 'no-preference' });
  }

  // ---- audio (see the audio section above startStream) ----
  let aDec = null, aCfg = null, aGen = 0, aOn = false, aErrors = 0, aTs = 0, aAvail = true;
  function setAudioAvail(v) {
    if (v === aAvail) return;
    aAvail = v;
    if (!v) { resetAudioDecoder(); flushAudio(); }
    try { onAudioState?.(v); } catch { /* ignore */ }
  }
  /** Ask the server for audio (or stop it) to match support, mute and errors. */
  function syncAudio() {
    audioSupported().then(ok => {
      if (closed) return;
      const want = ok && !A.muted && aErrors < 3;
      if (want !== aOn && send({ t: 'audio', on: want })) aOn = want;   // on: the server sends the config
      if (!want) { resetAudioDecoder(); flushAudio(); }
    }).catch(() => {});
  }
  function resetAudioDecoder() {
    aGen++; aCfg = null;
    const d = aDec; aDec = null;
    try { if (d && d.state !== 'closed') d.close(); } catch { /* ignore */ }
  }
  function audioError(err) {
    if (closed) return;
    console.warn('audio decoder error', err);
    resetAudioDecoder();
    if (++aErrors >= 3) { syncAudio(); return; }   // gives up: tells the server to stop sending audio
    if (aOn && send({ t: 'audio', on: false })) aOn = false;
    syncAudio();                                    // off, then on again: the server resends the config
  }
  function audioOutput(ad) {
    let planes = null;
    try {
      if (!closed && aOn && ad.sampleRate === 48000) {
        const n = ad.numberOfFrames, ch = Math.min(ad.numberOfChannels, 2);
        planes = [];
        for (let c = 0; c < ch; c++) {
          const p = new Float32Array(n);
          ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
          planes.push(p);
        }
        if (ch === 1) planes.push(planes[0]);
      }
    } catch (e) { planes = null; console.warn('audio copy failed', e); } finally { ad.close(); }
    if (planes) pushAudio(planes);
  }
  function audioConfig(data) {
    if (aDec && aCfg && aCfg.length === data.length && aCfg.every((b, i) => b === data[i])) return;
    resetAudioDecoder();
    const gen = aGen, desc = (aCfg = data.slice());
    const cfg = { ...OPUS, numberOfChannels: desc[9] === 1 ? 1 : 2, description: desc };
    AudioDecoder.isConfigSupported(cfg).then(r => {
      if (gen !== aGen || closed) return;
      if (!r.supported) throw new Error('Opus config not supported');
      const d = new AudioDecoder({ output: audioOutput, error: e => { if (d === aDec) audioError(e); } });
      d.configure(cfg);
      aDec = d;
    }).catch(e => { if (gen === aGen) audioError(e); });
  }
  function onAudio(kind, data) {
    if (!aOn) return;
    if (kind === 3) { setAudioAvail(true); return audioConfig(data); }
    if (!aDec || aDec.state !== 'configured' || aDec.decodeQueueSize > 10) return;
    aDec.decode(new EncodedAudioChunk({ type: 'key', timestamp: (aTs += 20000), data }));
  }

  function onPacket(pkt) {
    const kind = pkt[0], data = pkt.subarray(1);
    if (kind === 3 || kind === 4) {   // audio: never reaches the video decoder
      try { onAudio(kind, data); } catch (e) { audioError(e); }
      return;
    }
    if (kind === 0) {           // SPS/PPS: (re)configure on change (e.g. rotation)
      configData = data.slice();
      const c = codecFromConfig(configData);
      if (c !== codec || !decoder || decoder.state === 'closed') { codec = c; makeDecoder(); }
      return;
    }
    if (!decoder || decoder.state !== 'configured') return;
    if (kind === 1) {
      gotKey = true;
      const merged = new Uint8Array(configData.length + data.length);
      merged.set(configData);
      merged.set(data, configData.length);
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: ts++, data: merged }));
    } else if (gotKey) {
      if (decoder.decodeQueueSize > 6) { gotKey = false; send({ t: 'keyframe' }); return; }
      decoder.decode(new EncodedVideoChunk({ type: 'delta', timestamp: ts++, data }));
    }
  }

  const statTimer = setInterval(() => {
    send({ t: 'ping', ts: performance.now() });
    stats.fps = frames;
    stats.kbps = Math.round((bytes * 8) / 1000);   // includes audio (~100 kbps)
    try {
      stats.audioMs = aOn && aDec && A.ctx?.state === 'running'
        ? Math.round(((A.ctx.outputLatency || 0) + (A.ctx.baseLatency || 0)) * 1000) + 50 : 0;   // + ~50 ms jitter buffer
    } catch { stats.audioMs = 0; }
    frames = 0; bytes = 0;
  }, 1000);

  // ---- keyboard/mouse -> touch for landscape touch games (keymap.js; finger ids 40..64) ----
  const keymap = createKeymapper({ canvas, send, size: () => [videoW, videoH], padKeys: () => padKeys, on, layer: keymapLayer });

  // ---- touch / mouse ----
  const pointers = new Map(); // browser pointerId -> android finger id
  const toDevice = e => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(videoW - 1, ((e.clientX - r.left) / r.width) * videoW)),
      y: Math.max(0, Math.min(videoH - 1, ((e.clientY - r.top) / r.height) * videoH)),
    };
  };
  function touch(e, action, pid = e.pointerId) {
    if (!videoW) return;
    let id = pointers.get(pid);
    if (action === 0) {
      const used = new Set(pointers.values());
      for (id = 0; used.has(id); id++);
      pointers.set(pid, id);
      canvas.setPointerCapture(pid);
    }
    if (id === undefined) return;
    const { x, y } = toDevice(e);
    send({ t: 'touch', a: action, id, x, y, w: videoW, h: videoH, p: action === 1 ? 0 : (e.pressure || 1) });
    if (action === 1) pointers.delete(pid);
  }
  on(canvas, 'pointerdown', e => {
    if (keymap.pointerDown(e)) return;   // locks the mouse for mouse look, or it is locked (no taps)
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); canvas.focus(); touch(e, 0);
  });
  // Autoplay fallback: any gesture on the stream (re)starts audio output.
  on(canvas, 'pointerdown', () => { if (aOn && !document.hidden) unlockAudio(); });
  on(canvas, 'keydown', () => { if (aOn && !document.hidden) unlockAudio(); });
  on(canvas, 'pointermove', e => {
    if (!pointers.has(e.pointerId) || keymap.locked) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) touch(ev, 2, e.pointerId);
  });
  on(canvas, 'pointerup', e => touch(e, 1));
  on(canvas, 'pointercancel', e => touch(e, 1));
  on(canvas, 'contextmenu', e => { e.preventDefault(); if (!keymap.locked) send({ t: 'nav', k: 'back' }); });   // locked: right click = a mapped button
  on(canvas, 'wheel', e => {
    e.preventDefault();
    const { x, y } = toDevice(e);
    send({ t: 'scroll', x, y, w: videoW, h: videoH, hs: -e.deltaX / 120, vs: -e.deltaY / 120 });
  }, { passive: false });

  // ---- keyboard ----
  const meta = e => (e.shiftKey ? 0x1 : 0) | (e.altKey ? 0x2 : 0) | (e.ctrlKey ? 0x1000 : 0);
  const held = new Set();          // KEYPAD keys down (keyboard as controller)
  const down = new Map();          // raw keys sent down: e.code -> android keycode
  const onKey = action => e => {
    if (action === 0 && e.defaultPrevented) return;   // the UI consumed it (e.g. Escape closing the menu)
    // Mapped keys become touches and never reach the device as keys (keyups always get through).
    if (action === 1 ? keymap.keyUp(e) : !inputBlocked?.() && keymap.keyDown(e)) return;
    if (KEYPAD[e.code] && (action === 1 ? held.has(e.code) : padKeys && !e.ctrlKey && !e.metaKey && !e.altKey && !inputBlocked?.())) {
      e.preventDefault();
      if (action === 0) held.add(e.code); else held.delete(e.code);
      pollPads();
      return;
    }
    // A key we sent down always gets its keyup, even while the menu blocks input (else it sticks,
    // e.g. Ctrl after Ctrl+G); keyups of keys we never sent down are dropped for the same reason.
    if (action === 1) {
      if (!down.has(e.code)) return;
      e.preventDefault();
      send({ t: 'key', a: 1, k: down.get(e.code), m: meta(e) });
      down.delete(e.code);
      return;
    }
    if (inputBlocked?.()) return;
    const k = KEYMAP[e.code];
    if (k === undefined) return;
    e.preventDefault();
    if (e.repeat) return;
    if (send({ t: 'key', a: 0, k, m: meta(e) })) down.set(e.code, k);
  };
  /** Let go of every key held on the device (input is about to be blocked, or focus was lost). */
  function releaseKeys() {
    for (const k of down.values()) send({ t: 'key', a: 1, k, m: 0 });
    down.clear();
    held.clear();
    keymap.releaseAll();
    pollPads();
  }
  on(window, 'keydown', onKey(0));
  on(window, 'keyup', onKey(1));
  on(window, 'blur', releaseKeys);   // keyups are lost while unfocused
  // Hidden tabs stop rAF and gamepad updates, so the last pad state (say, a held trigger) would
  // stay applied on the device until the user returns: send neutral now, the real state on return.
  on(document, 'visibilitychange', () => { if (document.hidden) { releasePads(); keymap.releaseAll(); } sendVisibility(); });

  // ---- controllers: one virtual pad per browser gamepad (slot = gamepad index, 0-3) ----
  function keyboardPad() {
    const st = { ...NEUTRAL };
    for (const code of held) {
      for (const [k, v] of Object.entries(KEYPAD[code])) st[k] = k === 'b' ? st.b | v : st[k] + v;
    }
    for (const [x, y] of [['lx', 'ly'], ['rx', 'ry']]) {
      st[x] = Math.max(-1, Math.min(1, st[x]));
      st[y] = Math.max(-1, Math.min(1, st[y]));
      if (st[x] && st[y]) { st[x] = r2(st[x] * Math.SQRT1_2); st[y] = r2(st[y] * Math.SQRT1_2); }
    }
    st.lt = Math.min(1, st.lt);
    st.rt = Math.min(1, st.rt);
    return st;
  }
  function gamepadState(gp) {
    if (gp.mapping !== 'standard') return rawState(gp);
    const st = { ...NEUTRAL };
    gp.buttons.forEach((btn, i) => { if (STANDARD[i] && btn.pressed) st.b |= STANDARD[i]; });
    [st.lx, st.ly, st.rx, st.ry] = [0, 1, 2, 3].map(i => deadzone(gp.axes[i] || 0));
    st.lt = r2(gp.buttons[6]?.value || 0);
    st.rt = r2(gp.buttons[7]?.value || 0);
    return st;
  }
  // Unmapped pad: read as standard, its triggers (resting at -1) would pin the right stick. Sort
  // the axes by their resting value on first sight: ~-1 = analog trigger, the rest = sticks, then
  // a hat (d-pad) pair if there are axes left over.
  const layouts = new Map();       // gamepad index -> { id, trig: [axis], sticks: [axis] }
  function rawState(gp) {
    let lay = layouts.get(gp.index);
    if (!lay || lay.id !== gp.id) {
      const trig = [], sticks = [];
      gp.axes.forEach((v, i) => (v <= -0.5 ? trig : sticks).push(i));
      layouts.set(gp.index, (lay = { id: gp.id, trig, sticks }));
      onNotice?.(`Controller “${gp.id}” has no standard mapping in this browser; buttons may be mixed up. Chrome or Edge usually maps it properly.`);
    }
    const st = { ...NEUTRAL };
    gp.buttons.forEach((btn, i) => { if (RAW[i] && btn.pressed) st.b |= RAW[i]; });
    const ax = i => (i === undefined ? 0 : gp.axes[i] || 0);
    [st.lx, st.ly, st.rx, st.ry] = lay.sticks.slice(0, 4).map(i => deadzone(ax(i))).concat([0, 0, 0, 0]).slice(0, 4);
    const [hx, hy] = [ax(lay.sticks[4]), ax(lay.sticks[5])];
    if (hx < -0.5) st.b |= B.LEFT; else if (hx > 0.5) st.b |= B.RIGHT;
    if (hy < -0.5) st.b |= B.UP; else if (hy > 0.5) st.b |= B.DOWN;
    [st.lt, st.rt] = [0, 1].map(j => (lay.trig[j] === undefined ? 0 : r2(Math.max(0, (ax(lay.trig[j]) + 1) / 2))));
    return st;
  }
  const merge = (a, k) => ({
    b: a.b | k.b, lt: Math.max(a.lt, k.lt), rt: Math.max(a.rt, k.rt),
    ...Object.fromEntries(['lx', 'ly', 'rx', 'ry'].map(x => [x, Math.max(-1, Math.min(1, a[x] + k[x]))])),
  });
  const sent = new Map();          // slot -> last state sent (JSON)
  function pollPads() {
    const pads = [...(navigator.getGamepads?.() ?? [])];
    // Nothing to drive (no keyboard pad, no pad ever sent, none plugged in): skip the per-frame work.
    if (!padKeys && !sent.size && !pads.some(p => p?.connected)) return;
    for (let slot = 0; slot < 4; slot++) {
      const gp = pads.find(p => p?.connected && p.index === slot);
      let st = gp ? gamepadState(gp) : null;
      if (slot === 0 && padKeys) st = st ? merge(st, keyboardPad()) : keyboardPad();
      // Hidden tab: still poll (the ws 'open' poll must create controller 1 before the game boots),
      // but only ever send neutral so stale held input isn't resent; live state resumes on return.
      if (st && document.hidden) st = { ...NEUTRAL };
      if (!st && !sent.has(slot)) continue;             // never used: no device for it
      const json = JSON.stringify(st || NEUTRAL);
      if (sent.get(slot) === json) continue;
      if (send({ t: 'pad', i: slot, ...(st || NEUTRAL) })) sent.set(slot, json);
    }
  }
  // Neutral for every pad we drive; recorded as sent so the first poll on return resends live state.
  function releasePads() {
    const n = JSON.stringify(NEUTRAL);
    for (const [slot, json] of sent) if (json !== n && send({ t: 'pad', i: slot, ...NEUTRAL })) sent.set(slot, n);
  }
  let raf = requestAnimationFrame(function poll() {
    pollPads();
    raf = requestAnimationFrame(poll);
  });

  return {
    stats,
    nav: k => send({ t: 'nav', k }),
    rotate: () => send({ t: 'rotate' }),
    relaunch: () => send({ t: 'relaunch' }),   // after {t:'game', state:'exited'}: start the game again
    get padKeys() { return padKeys; },
    setPadKeys(on) { padKeys = !!on; held.clear(); pollPads(); keymap.setEnabled(keymap.enabled); },
    keymap,
    releaseKeys,
    /** Re-check audio after the mute setting changed (setAudioMuted): asks the server to start/stop. */
    syncAudio,
    get audioAvailable() { return aAvail; },   // false: the server's stream has no audio (old server: stays true)
    text: s => { if (s) send({ t: 'text', s }); send({ t: 'key', a: 0, k: 66 }); send({ t: 'key', a: 1, k: 66 }); },
    stop() {
      closed = true;
      keymap.destroy();   // lets go of mapped fingers while the socket is still open
      ac.abort();
      clearInterval(statTimer);
      cancelAnimationFrame(raf);
      ws.close();
      if (decoder && decoder.state !== 'closed') decoder.close();
      try { resetAudioDecoder(); flushAudio(); } catch { /* ignore */ }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    },
  };
}
