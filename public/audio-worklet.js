// Rose audio jitter buffer (AudioWorklet). stream.js posts decoded stereo audio (at the context rate) here as
// { planes: [Float32Array L, Float32Array R] } (transferred), or { flush: true } to drop it all.
// Playback starts once START frames are buffered and aims to hover around TARGET. If more than
// MAX builds up (a stall, then a burst), the excess is skipped with a short crossfade so latency
// never creeps up. On underrun it outputs silence and waits to re-prime.
// Plain script with no imports or exports, so it loads as a module or as a classic script.

// The context's own rate: stream.js resamples the decoder's 48 kHz to it when they differ.
const RATE = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
const RING = Math.round(RATE / 2);                   // 500 ms per channel
const START = Math.round(RATE * 0.040);  // begin (or resume after underrun) at 40 ms buffered
const TARGET = Math.round(RATE * 0.050); // skip back down to ~50 ms...
const MAX = Math.round(RATE * 0.150);    // ...when more than 150 ms is buffered

class RoseAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = [new Float32Array(RING), new Float32Array(RING)];
    this.r = 0;          // read index
    this.n = 0;          // frames buffered
    this.playing = false;
    this.port.onmessage = e => {
      const m = e.data;
      if (m?.flush) { this.r = 0; this.n = 0; this.playing = false; return; }
      if (m?.planes) this.write(m.planes);
    };
  }

  write(planes) {
    const L = planes[0], R = planes[1] || planes[0];
    let len = L.length, src = 0;
    if (len >= RING) { src = len - RING + 1; len = RING - 1; }   // absurdly large chunk: keep its tail
    const over = this.n + len - (RING - 1);
    if (over > 0) { this.r = (this.r + over) % RING; this.n -= over; }   // full: drop the oldest
    let w = (this.r + this.n) % RING;
    for (let i = 0; i < len; i++) {
      this.ring[0][w] = L[src + i];
      this.ring[1][w] = R[src + i];
      if (++w === RING) w = 0;
    }
    this.n += len;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const frames = oL.length;
    if (!this.playing && this.n >= START) this.playing = true;
    if (!this.playing) { oL.fill(0); oR.fill(0); return true; }

    const [L, R] = this.ring;
    if (this.n > MAX && this.n - TARGET >= frames) {
      // Crossfade from the oldest audio into the audio TARGET frames from the end, over one quantum.
      const skip = this.n - TARGET;
      for (let i = 0; i < frames; i++) {
        const a = (this.r + i) % RING, b = (this.r + skip + i) % RING, g = (i + 1) / frames;
        oL[i] = L[a] * (1 - g) + L[b] * g;
        if (oR !== oL) oR[i] = R[a] * (1 - g) + R[b] * g;
      }
      this.r = (this.r + skip + frames) % RING;
      this.n -= skip + frames;
      return true;
    }

    const take = Math.min(frames, this.n);
    for (let i = 0; i < take; i++) {
      oL[i] = L[this.r];
      if (oR !== oL) oR[i] = R[this.r];
      if (++this.r === RING) this.r = 0;
    }
    this.n -= take;
    if (take < frames) {   // underrun: short fade to silence, then re-prime
      if (take) for (let i = Math.max(0, take - 32); i < take; i++) { const g = (take - i) / 33; oL[i] *= g; if (oR !== oL) oR[i] *= g; }
      oL.fill(0, take);
      if (oR !== oL) oR.fill(0, take);
      this.playing = false;
    }
    for (let c = 2; c < out.length; c++) out[c].set(oL);
    return true;
  }
}

registerProcessor('rose-audio', RoseAudio);
