// Piano samples (FluidR3, MIT) through Web Audio, plus the masking tone cloud used in tests.
import { NOTE_IDS, SAMPLE_FILE } from './plan.js';

export class Audio {
  constructor(base = 'sounds/') {
    this.base = base;
    this.ctx = null;
    this.buffers = {};
    this.master = null;
  }

  /** Must be called from a user gesture (iOS). */
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    // a silent blip keeps iOS happy
    const b = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start(0);
  }

  async load(onProgress) {
    let done = 0;
    await Promise.all(NOTE_IDS.map(async (n) => {
      const res = await fetch(`${this.base}${SAMPLE_FILE[n]}.mp3`);
      if (!res.ok) throw new Error(`sound ${n}: ${res.status}`);
      const arr = await res.arrayBuffer();
      this.buffers[n] = await new Promise((ok, fail) => this.ctx.decodeAudioData(arr, ok, fail));
      done += 1;
      onProgress?.(done / NOTE_IDS.length);
    }));
  }

  /** Play a note; returns the performance.now() time of its onset. */
  playNote(note, delay = 0.05, dur = 1.3) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[note];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(1, t0 + 0.008);
    g.gain.setValueAtTime(1, t0 + dur);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur + 0.35);
    src.connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.4);
    return performance.now() + (t0 - ctx.currentTime) * 1000;
  }

  /** A short cloud of random tones that breaks the memory of the previous note. Returns its length (s). */
  playMask(delay = 0.05) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const len = 0.55;
    for (let i = 0; i < 12; i++) {
      const f = 170 * Math.pow(2, Math.random() * 2.8); // ~170..1200 Hz, log-uniform
      const start = t0 + Math.random() * (len - 0.08);
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.09, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.08);
      o.connect(g).connect(this.master);
      o.start(start);
      o.stop(start + 0.09);
    }
    return len;
  }
}
