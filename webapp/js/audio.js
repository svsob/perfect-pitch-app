// Piano samples (FluidR3, MIT) through Web Audio, and the pitchless noise played before each test note.
import { NOTE_IDS, SAMPLE_FILE } from './plan.js?v=8';

export class Audio {
  constructor(base = 'sounds/') {
    this.base = base;
    this.ctx = null;
    this.buffers = {};
    this.master = null;
    this.noise = null;
    this.playing = [];
    this.hash = '';
  }

  /** Must be called from a user gesture (tap). Everything before the first await runs inside the gesture. */
  unlock() {
    // iOS 17+: treat this page as media playback, so the silent switch does not mute it.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* old WebKit */ }
    // Older iOS: a looping silent <audio> element switches the audio session to "playback" as well.
    this.keepAlive();
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.wake(); });
    }
    const b = this.ctx.createBuffer(1, 1, 22050); // a silent blip, inside the gesture
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start(0);
    return this.ctx.state === 'running' ? Promise.resolve() : this.ctx.resume();
  }

  wake() {
    if (this.el && this.el.paused) this.el.play().catch(() => {});
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  keepAlive() {
    if (!this.el) {
      const el = document.createElement('audio');
      el.setAttribute('playsinline', '');
      el.setAttribute('x-webkit-airplay', 'deny');
      el.loop = true;
      el.preload = 'auto';
      el.src = URL.createObjectURL(silentWav());
      this.el = el;
    }
    this.el.play().catch(() => { /* not allowed yet: the next tap tries again */ });
  }

  get state() {
    return this.ctx ? this.ctx.state : 'none';
  }

  get ready() {
    return !!this.ctx && Object.keys(this.buffers).length === NOTE_IDS.length && !!this.noise;
  }

  /** Load the seven samples and remember a fingerprint of the files (which stimulus set was used). */
  async load(onProgress) {
    let done = 0;
    const raw = {};
    await Promise.all(NOTE_IDS.map(async (n) => {
      if (this.buffers[n]) { done += 1; return; }
      const res = await fetch(`${this.base}${SAMPLE_FILE[n]}.mp3`);
      if (!res.ok) throw new Error(`sound ${n}: ${res.status}`);
      const arr = await res.arrayBuffer();
      raw[n] = arr.slice(0);
      this.buffers[n] = await new Promise((ok, fail) => this.ctx.decodeAudioData(arr, ok, fail));
      done += 1;
      onProgress?.(done / NOTE_IDS.length);
    }));
    if (!this.noise) this.noise = makeNoise(this.ctx, 2.5);
    // noise at about the loudness of the notes (it used to be much louder): RMS of the first 1.5 s of each sample
    const rms = NOTE_IDS.map((n) => {
      const d = this.buffers[n].getChannelData(0);
      const len = Math.min(d.length, Math.floor(this.buffers[n].sampleRate * 1.5));
      let sum = 0;
      for (let i = 0; i < len; i++) sum += d[i] * d[i];
      return Math.sqrt(sum / len);
    });
    const noteRms = rms.reduce((a, b) => a + b, 0) / rms.length;
    this.noiseGain = Math.min(0.06, Math.max(0.003, (0.6 * noteRms) / 0.33)); // 0.33 = RMS of the filtered noise
    if (!this.hash && Object.keys(raw).length === NOTE_IDS.length) {
      try {
        const parts = NOTE_IDS.map((n) => new Uint8Array(raw[n]));
        const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let o = 0;
        for (const p of parts) { all.set(p, o); o += p.length; }
        const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
        this.hash = [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { this.hash = 'na'; }
    }
  }

  /** Stop whatever is sounding (short fade, no click). */
  stopAll(fade = 0.04) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const { src, g } of this.playing) {
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + fade);
        src.stop(t + fade + 0.01);
      } catch { /* already stopped */ }
    }
    this.playing = [];
  }

  _track(src, g) {
    const item = { src, g };
    this.playing.push(item);
    src.onended = () => { this.playing = this.playing.filter((x) => x !== item); };
  }

  /** Play a note for `dur` seconds; returns the performance.now() time of its onset. */
  playNote(note, delay = 0.03, dur = 3.0) {
    const ctx = this.ctx;
    this.wake();
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[note];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(1, t0 + 0.008);
    g.gain.setValueAtTime(1, t0 + dur - 0.15);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    src.connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    this._track(src, g);
    return performance.now() + (t0 - ctx.currentTime) * 1000;
  }

  /** Pitchless (white) noise for `ms` milliseconds; returns the performance.now() time when it ends. */
  playNoise(ms, delay = 0.03) {
    const ctx = this.ctx;
    this.wake();
    const t0 = ctx.currentTime + delay;
    const len = ms / 1000;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    const level = this.noiseGain || 0.02;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.05);
    g.gain.setValueAtTime(level, t0 + len - 0.05);
    g.gain.linearRampToValueAtTime(0, t0 + len);
    const lp = ctx.createBiquadFilter(); // softer, less hissy: no definite pitch, energy mostly below 3 kHz
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    src.connect(lp).connect(g).connect(this.master);
    src.start(t0, Math.random() * 0.4);
    src.stop(t0 + len + 0.01);
    this._track(src, g);
    return performance.now() + (t0 - ctx.currentTime + len) * 1000;
  }
}

function makeNoise(ctx, seconds) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** 0.5 s of 8 kHz mono silence as a WAV file. */
function silentWav() {
  const n = 4000;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return new Blob([buf], { type: 'audio/wav' });
}
