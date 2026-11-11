// Minimal scrcpy (v3.x) client: launches scrcpy-server on the device, reads the H.264
// stream and exposes a control channel. Protocol ref: scrcpy/doc/develop.md
import net from 'node:net';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { PAD_DESCRIPTOR, PAD_VENDOR, PAD_PRODUCT, padReport } from './gamepad.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
const OPUS = 0x6f707573;             // audio codec id "opus"

// Control message types (scrcpy 3.x)
const T = {
  KEY: 0, TEXT: 1, TOUCH: 2, SCROLL: 3, BACK_OR_SCREEN_ON: 4, ROTATE: 11,
  UHID_CREATE: 12, UHID_INPUT: 13, UHID_DESTROY: 14, RESET_VIDEO: 17,
};

/** Buffered reader over a socket so we can await exact byte counts. */
class Reader {
  constructor(sock) {
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.closed = false;
    // Most reads find the buffer empty: take the chunk as is instead of copying it.
    sock.on('data', d => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this.wake(); });
    sock.on('close', () => { this.closed = true; this.wake(); });
    sock.on('error', () => {});
  }
  wake() { const w = this.waiter; this.waiter = null; w?.(); }
  async read(n) {
    while (this.buf.length < n) {
      if (this.closed) throw new Error('socket closed');
      await new Promise(r => (this.waiter = r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

export class Scrcpy extends EventEmitter {
  constructor(adb, serverPath, version, opts) {
    super();
    this.adb = adb;
    this.serverPath = serverPath;
    this.version = version;
    this.opts = opts;
    this.config = null;       // last SPS/PPS packet (sent to late joiners)
    this.width = 0;
    this.height = 0;
    this.stopped = false;
    this.gen = 0;             // scrcpy-server run (a run without audio replaces one that crashed on it)
    this.audio = false;       // is audio streaming in this run?
    this.audioConfig = null;  // last OpusHead config packet
  }

  async start() {
    await this.adb.push(this.serverPath, REMOTE_JAR);
    for (;;) {
      try {
        await this.launch();
        this.started = true;         // from now on died() handles a crash
        return;
      } catch (e) {
        // An audio-related crash right after start: try once more without audio (video matters more).
        if (this.stopped || !(await this.audioCrashed())) throw e;
        await this.withoutAudio();
      }
    }
  }

  /** One scrcpy-server run: spawn it, connect video (then audio) and control, read the video meta. */
  async launch() {
    const gen = ++this.gen;
    this.scid = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    const scidHex = this.scid.toString(16).padStart(8, '0');
    this.port = await this.adb.forward(`localabstract:scrcpy_${scidHex}`);
    const audio = !!this.opts.audio;
    this.audio = audio;              // false once the server reports it can't capture
    this.audioConfig = null;         // OpusHead of this run (sent to viewers that turn audio on)

    const args = [
      `scid=${scidHex}`, 'log_level=warn', 'tunnel_forward=true',
      // Audio: REMOTE_SUBMIX capture (audio_source=output, the default; "playback" needs Android 13),
      // Opus at 96 kbps. Verified on redroid 12 (backups/before-audio-20261103/audio-plan.json).
      ...(audio ? ['audio=true', 'audio_codec=opus', 'audio_bit_rate=96000'] : ['audio=false']),
      'control=true', 'cleanup=false', 'video_codec=h264',
      `max_size=${this.opts.maxSize}`, `video_bit_rate=${this.opts.bitrate}`,
      `max_fps=${this.opts.maxFps}`, 'stay_awake=true', 'power_off_on_close=false',
      // cleanup=false: no CleanUp helper process (a second JVM, ~100 MB). It only restores settings
      // on exit, and Rose sets stay-on itself (adb.js optimize()); the container is thrown away anyway.
      // low-latency encoder hints
      'video_codec_options=profile:int=1,level:int=4096,i-frame-interval:int=2',
    ].join(' ');
    const proc = this.proc = this.adb.spawnShell(`CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${this.version} ${args}`);
    this.launchedAt = Date.now();
    this.stderrTail = '';
    proc.exited = new Promise(r => proc.once('exit', r));
    proc.stderr.on('data', d => {
      const t = d.toString();
      if (proc === this.proc) this.stderrTail = (this.stderrTail + t).slice(-4096);
      console.warn(`[scrcpy ${this.adb.serial}]`, t.trim());
    });
    proc.on('exit', () => { proc.done = true; proc.doneAt = Date.now(); this.died(gen, new Error('scrcpy-server exited')); });

    // With tunnel_forward the adb forward accepts immediately even before the server
    // listens; the server's dummy byte tells us the connection is real.
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (proc.done) throw new Error('scrcpy-server exited during start');
      const sock = net.connect(this.port, '127.0.0.1');
      const reader = new Reader(sock);
      try {
        await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
        await reader.read(1);
        this.videoSock = sock;
        this.videoReader = reader;
        break;
      } catch {
        sock.destroy();
        if (Date.now() > deadline) throw new Error('could not connect to scrcpy-server');
        await sleep(150);
      }
    }
    // The server accepts one connection per enabled stream, in this fixed order: video, audio, control.
    if (audio) {
      const a = this.audioSock = net.connect(this.port, '127.0.0.1');
      this.audioReader = new Reader(a);
      await new Promise((res, rej) => { a.once('connect', res); a.once('error', rej); });
    }
    this.controlSock = net.connect(this.port, '127.0.0.1');
    this.controlSock.setNoDelay(true);
    this.controlSock.on('error', () => {});
    this.controlSock.on('data', () => {}); // device messages (clipboard etc.) ignored

    const r = this.videoReader;
    this.deviceName = (await r.read(64)).toString('utf8').replace(/\0.*$/s, '');
    const meta = await r.read(12); // codec id, width, height
    this.width = meta.readUInt32BE(4);
    this.height = meta.readUInt32BE(8);
    this.videoSock.setNoDelay(true);
    this.pump(r).catch(e => this.died(gen, e));
    // Separate from the video pump: audio never delays or blocks video.
    if (audio) this.audioPump(gen, this.audioReader, this.audioSock).catch(e => {
      if (gen === this.gen && !this.stopped) console.warn(`[scrcpy ${this.adb.serial}] audio stream ended: ${e.message}`);
    });
  }

  /**
   * The server process exited or the video stream broke. Ends the stream, unless audio crashed it
   * right after start: then it runs again without audio (same object, so viewers and input stay).
   */
  async died(gen, err) {
    if (this.stopped || gen !== this.gen || this.dying === gen || !this.started || this.relaunching) return;
    this.dying = gen;
    try {
      if (await this.audioCrashed()) {
        if (this.stopped || gen !== this.gen) return;
        this.relaunching = true;     // the new run's own failures are reported below, once
        await this.withoutAudio();
        await this.launch();
        this.emit('restarted');
        return;
      }
    } catch (e) {
      err = e;
    } finally {
      this.relaunching = false;
    }
    if (!this.stopped) this.emit('end', err);
  }

  /** Did this run's server exit within ~5 s of starting, with an audio-related error? */
  async audioCrashed() {
    if (!this.opts.audio) return false;
    const proc = this.proc;
    // stderr is only complete once the process is gone (the socket usually closes first).
    await Promise.race([proc.exited, sleep(1500)]);
    return !!proc.done && proc.doneAt - this.launchedAt < 5000 && /audio|opus/i.test(this.stderrTail);
  }

  /** Tear down the current run and switch audio off for the rest of this stream. */
  async withoutAudio() {
    console.warn(`[scrcpy ${this.adb.serial}] scrcpy-server died with an audio error; restarting without audio`);
    this.opts = { ...this.opts, audio: false };
    this.audio = false;
    this.audioConfig = null;
    this.emit('audiostate', false);
    this.gen++;                      // late events from the old run are ignored
    this.videoSock?.destroy();
    this.audioSock?.destroy();
    this.controlSock?.destroy();
    this.proc?.kill('SIGKILL');
    if (this.port) await this.adb.removeForward(this.port);
  }

  async pump(r) {
    for (;;) {
      const hdr = await r.read(12);
      const ptsFlags = hdr.readBigUInt64BE(0);
      const len = hdr.readUInt32BE(8);
      // read() returns a view of socket chunks that are never written again, and every listener
      // copies the packet out synchronously, so frames need no copy of their own.
      const data = await r.read(len);
      const isConfig = (ptsFlags >> 63n) & 1n;
      const isKey = (ptsFlags >> 62n) & 1n;
      if (isConfig) {
        // Kept for late joiners: copy it, so it doesn't pin the (maybe large) chunk it came in.
        this.config = Buffer.from(data);
        this.emit('packet', 0, data);
      } else {
        this.emit('packet', isKey ? 1 : 2, data);
      }
    }
  }

  /**
   * Audio socket: u32 codec id, then packets with the same 12-byte header as video. The OpusHead
   * config is kept for viewers that turn audio on; every packet is emitted as ('audio', 3|4, data).
   * The socket is always drained, or the server's audio thread would block on write.
   */
  async audioPump(gen, r, sock) {
    const codec = (await r.read(4)).readUInt32BE(0);
    if (codec !== OPUS) {
      // 0 = audio disabled by the server (unsupported source), 1 = error: keep video going.
      console.warn(`[scrcpy ${this.adb.serial}] no audio (codec id ${codec})`);
      this.audio = false;
      this.emit('audiostate', false);
      sock.removeAllListeners('data');
      sock.on('data', () => {});     // keep draining whatever follows
      return;
    }
    let fixed = false;
    for (;;) {
      const hdr = await r.read(12);
      const isConfig = (hdr.readBigUInt64BE(0) >> 63n) & 1n;
      const data = await r.read(hdr.readUInt32BE(8));
      if (gen !== this.gen || this.stopped) return;
      if (isConfig) {
        this.audioConfig = Buffer.from(data);
        this.emit('audio', 3, data);
      } else {
        this.emit('audio', 4, data);
        // Only now is media routed to the remote submix, whose MUSIC volume defaults to 5/15 (-33 dB).
        if (!fixed) { fixed = true; this.fixVolume(gen); }
      }
    }
  }

  /** Raise STREAM_MUSIC on remote_submix to 15/15 (no UI drawn); check dumpsys, retry once. */
  async fixVolume(gen) {
    for (let i = 0; i < 2; i++) {
      if (gen !== this.gen || this.stopped) return;
      try {
        await this.adb.shell('cmd media_session volume --stream 3 --set 15', { timeout: 10_000 });
        const out = await this.adb.shell('dumpsys audio', { timeout: 10_000 });
        const music = out.split(/^\s*- STREAM_MUSIC:/m)[1]?.split(/^\s*- STREAM_/m)[0] || '';
        if (/\(remote_submix\): 15\b/.test(music)) return;
      } catch (e) {
        console.warn(`[scrcpy ${this.adb.serial}] audio volume: ${e.message.split('\n')[0]}`);
      }
      await sleep(1000);
    }
    console.warn(`[scrcpy ${this.adb.serial}] could not confirm the remote_submix music volume`);
  }

  // ---- control ----
  send(buf) {
    if (this.controlSock?.writable) this.controlSock.write(buf);
  }

  /** Ask the encoder for a fresh keyframe (used when a viewer joins/recovers). */
  resetVideo() { this.send(Buffer.from([T.RESET_VIDEO])); }

  touch(action, pointerId, x, y, w, h, pressure = 1) {
    const b = Buffer.alloc(32);
    b.writeUInt8(T.TOUCH, 0);
    b.writeUInt8(action, 1);               // 0 down, 1 up, 2 move
    b.writeBigUInt64BE(BigInt(pointerId), 2);
    b.writeInt32BE(Math.round(x), 10);
    b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(w, 18);
    b.writeUInt16BE(h, 20);
    b.writeUInt16BE(Math.min(0xffff, Math.round(pressure * 0xffff)), 22);
    b.writeUInt32BE(0, 24);                // action button
    b.writeUInt32BE(0, 28);                // buttons
    this.send(b);
  }

  key(action, keycode, repeat = 0, meta = 0) {
    const b = Buffer.alloc(14);
    b.writeUInt8(T.KEY, 0);
    b.writeUInt8(action, 1);               // 0 down, 1 up
    b.writeInt32BE(keycode, 2);
    b.writeInt32BE(repeat, 6);
    b.writeInt32BE(meta, 10);
    this.send(b);
  }

  text(str) {
    const t = Buffer.from(str.slice(0, 300), 'utf8');
    const b = Buffer.alloc(5 + t.length);
    b.writeUInt8(T.TEXT, 0);
    b.writeUInt32BE(t.length, 1);
    t.copy(b, 5);
    this.send(b);
  }

  scroll(x, y, w, h, hs, vs) {
    const fx = v => Math.max(-0x8000, Math.min(0x7fff, Math.round(Math.max(-1, Math.min(1, v)) * 0x8000)));
    const b = Buffer.alloc(21);
    b.writeUInt8(T.SCROLL, 0);
    b.writeInt32BE(Math.round(x), 1);
    b.writeInt32BE(Math.round(y), 5);
    b.writeUInt16BE(w, 9);
    b.writeUInt16BE(h, 11);
    b.writeInt16BE(fx(hs), 13);
    b.writeInt16BE(fx(vs), 15);
    b.writeUInt32BE(0, 17);
    this.send(b);
  }

  rotate() { this.send(Buffer.from([T.ROTATE])); }

  // ---- virtual gamepads (UHID). Only send these once /dev/uhid is known to be accessible:
  // if the server fails to open it, its whole control channel stops. ----
  padOpen(id, name) {
    const n = Buffer.from(String(name).replace(/[^\x20-\x7e]/g, '').slice(0, 127), 'ascii');
    const b = Buffer.alloc(8 + n.length + 2 + PAD_DESCRIPTOR.length);
    let o = b.writeUInt8(T.UHID_CREATE, 0);
    o = b.writeUInt16BE(id, o);
    o = b.writeUInt16BE(PAD_VENDOR, o);
    o = b.writeUInt16BE(PAD_PRODUCT, o);
    o = b.writeUInt8(n.length, o);
    o += n.copy(b, o);
    o = b.writeUInt16BE(PAD_DESCRIPTOR.length, o);
    PAD_DESCRIPTOR.copy(b, o);
    this.send(b);
  }

  padInput(id, state) {
    const report = padReport(state);
    const b = Buffer.alloc(5 + report.length);
    b.writeUInt8(T.UHID_INPUT, 0);
    b.writeUInt16BE(id, 1);
    b.writeUInt16BE(report.length, 3);
    report.copy(b, 5);
    this.send(b);
  }

  padClose(id) {
    const b = Buffer.alloc(3);
    b.writeUInt8(T.UHID_DESTROY, 0);
    b.writeUInt16BE(id, 1);
    this.send(b);
  }

  async stop() {
    this.stopped = true;
    this.videoSock?.destroy();
    this.audioSock?.destroy();
    this.controlSock?.destroy();
    this.proc?.kill('SIGKILL');
    if (this.port) await this.adb.removeForward(this.port);
  }
}
