// Audio engine. Takes any BaseAudioContext so the very same graph can render offline (WAV export, tests).
import { midiToFreq } from './coords.js';
import { INSTRUMENTS } from './presets.js';

export const MAX_VOICES = 40;

export function createContext() {
  const A = window.AudioContext || window.webkitAudioContext;
  if (!A) throw new Error('Цей браузер не підтримує Web Audio');
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
  return new A({ latencyHint: 'interactive' });
}

const makeCurve = (amount) => {
  const n = 1024, c = new Float32Array(n), k = 1 + amount * 24;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
  return c;
};

function impulse(ctx, seconds, decay) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += ((Math.random() * 2 - 1) - lp) * 0.55;
      d[i] = lp * Math.pow(1 - i / n, decay);
    }
  }
  return buf;
}

export class Engine {
  constructor(ctx) {
    this.ctx = ctx;
    this.buses = new Map();
    this.voices = new Set();
    this.created = 0;
    this.ended = 0;
    this.master = {};
    this.anySolo = false;
    this.openHat = null;
    this.monitor = null;
    this._build();
  }

  _build() {
    const c = this.ctx;
    const mk = (type) => c.createGain();
    this.mix = c.createGain();
    // chorus / stereo width
    this.chorusDry = c.createGain();
    this.chorusWet = c.createGain();
    const lfo = c.createOscillator(); lfo.frequency.value = 0.35;
    this.chorusNodes = [0.018, 0.027].map((base, i) => {
      const d = c.createDelay(0.08); d.delayTime.value = base;
      const depth = c.createGain(); depth.gain.value = 0.004 * (i ? -1 : 1);
      lfo.connect(depth); depth.connect(d.delayTime);
      const pan = c.createStereoPanner(); pan.pan.value = i ? 0.85 : -0.85;
      this.mix.connect(d); d.connect(pan); pan.connect(this.chorusWet);
      return d;
    });
    lfo.start();
    this.pre = c.createGain();
    this.mix.connect(this.chorusDry); this.chorusDry.connect(this.pre); this.chorusWet.connect(this.pre);
    // reverb
    this.revSend = c.createGain();
    this.reverb = c.createConvolver(); this.reverb.buffer = impulse(c, 2.4, 2.6);
    this.revReturn = c.createGain();
    this.revSend.connect(this.reverb); this.reverb.connect(this.revReturn); this.revReturn.connect(this.pre);
    // tempo-synced ping delay with filtered feedback (feedback < 0.6, cannot run away)
    this.dlySend = c.createGain();
    this.delay = c.createDelay(2); this.delay.delayTime.value = 0.375;
    this.fb = c.createGain(); this.fb.gain.value = 0.42;
    this.fbFilter = c.createBiquadFilter(); this.fbFilter.type = 'lowpass'; this.fbFilter.frequency.value = 3200;
    this.dlyReturn = c.createGain();
    this.dlySend.connect(this.delay); this.delay.connect(this.fbFilter); this.fbFilter.connect(this.fb); this.fb.connect(this.delay);
    this.fbFilter.connect(this.dlyReturn); this.dlyReturn.connect(this.pre);
    // master drive -> compressor -> limiter -> soft clip -> volume
    this.drive = c.createWaveShaper(); this.drive.oversample = '2x';
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 10; this.comp.ratio.value = 3; this.comp.attack.value = 0.008; this.comp.release.value = 0.2;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.08;
    this.clip = c.createWaveShaper();
    const cl = new Float32Array(512); for (let i = 0; i < 512; i++) { const x = (i / 511) * 2 - 1; cl[i] = Math.tanh(x * 1.1) / Math.tanh(1.1); }
    this.clip.curve = cl;
    this.out = c.createGain();
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.78; this.analyser.minDecibels = -95; this.analyser.maxDecibels = -8;
    this.pre.connect(this.drive); this.drive.connect(this.comp); this.comp.connect(this.limiter); this.limiter.connect(this.clip);
    this.clip.connect(this.out); this.out.connect(this.analyser); this.out.connect(c.destination);
    // shared noise
    const nb = c.createBuffer(1, c.sampleRate, c.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = nb;
  }

  setMaster(m, bpm = 120) {
    const t = this.ctx.currentTime, tc = 0.02;
    this.master = { ...m };
    this.out.gain.setTargetAtTime(m.vol * 0.9, t, tc);
    this.revReturn.gain.setTargetAtTime(m.reverb * 0.9, t, tc);
    this.dlyReturn.gain.setTargetAtTime(m.delay * 0.8, t, tc);
    this.delay.delayTime.setTargetAtTime(Math.min(1.9, (60 / bpm) * 0.75), t, 0.05);
    this.chorusWet.gain.setTargetAtTime(m.chorus * 0.7, t, tc);
    this.chorusDry.gain.setTargetAtTime(1 - m.chorus * 0.25, t, tc);
    if (this._drv !== m.drive) { this._drv = m.drive; this.drive.curve = m.drive > 0.01 ? makeCurve(m.drive * 0.5) : null; }
  }

  // ---- tracks ----
  syncTracks(tracks) {
    const t = this.ctx.currentTime;
    this.anySolo = tracks.some((x) => x.solo);
    const alive = new Set();
    for (const tr of tracks) {
      alive.add(tr.id);
      let b = this.buses.get(tr.id);
      if (!b) {
        const c = this.ctx;
        b = { in: c.createGain(), shaper: c.createWaveShaper(), vol: c.createGain(), pan: c.createStereoPanner(), rev: c.createGain(), dly: c.createGain(), drv: -1 };
        b.in.connect(b.shaper); b.shaper.connect(b.vol); b.vol.connect(b.pan);
        b.pan.connect(this.mix); b.pan.connect(b.rev); b.pan.connect(b.dly);
        b.rev.connect(this.revSend); b.dly.connect(this.dlySend);
        this.buses.set(tr.id, b);
      }
      b.audible = !tr.mute && (!this.anySolo || tr.solo);
      b.vol.gain.setTargetAtTime(b.audible ? tr.vol : 0, t, 0.015);
      b.pan.pan.setTargetAtTime(tr.pan || 0, t, 0.02);
      b.rev.gain.setTargetAtTime(tr.rev || 0, t, 0.02);
      b.dly.gain.setTargetAtTime(tr.dly || 0, t, 0.02);
      const drv = tr.drive || 0;
      if (b.drv !== drv) { b.drv = drv; b.shaper.curve = drv > 0.01 ? makeCurve(drv * 0.6) : null; }
    }
    for (const [id, b] of this.buses) if (!alive.has(id)) {
      try { b.pan.disconnect(); b.vol.disconnect(); b.in.disconnect(); b.shaper.disconnect(); b.rev.disconnect(); b.dly.disconnect(); } catch (e) { /* ignore */ }
      this.buses.delete(id);
    }
  }
  isAudible(id) { const b = this.buses.get(id); return !!b && b.audible; }

  // ---- voices ----
  _track(voice) {
    this.voices.add(voice);
    this.created++;
    if (this.voices.size > MAX_VOICES) {
      let oldest = null;
      for (const v of this.voices) if (!v.dead && (!oldest || v.t0 < oldest.t0)) oldest = v;
      if (oldest) oldest.kill(this.ctx.currentTime);
    }
    return voice;
  }

  // Shared synth voice. `automate(oscs, t0, t1)` lets note/curve callers set pitch.
  _voice(track, t0, t1, vel, f0, automate) {
    const c = this.ctx;
    const bus = this.buses.get(track.id);
    if (!bus) return null;
    const inst = track.inst;
    const out = c.createGain();
    const oscs = []; // {o, mul}
    const nodes = [out];
    const wave = track.wave || 'sawtooth';
    const add = (type, mul, detune, level, dest = out) => {
      const o = c.createOscillator(); o.type = type; o.detune.value = detune;
      const g = c.createGain(); g.gain.value = level;
      o.connect(g); g.connect(dest); oscs.push({ o, mul }); nodes.push(o, g);
      return o;
    };
    let level = 1;
    if (inst === 'bass') { add('sine', 1, 0, 0.62); add(wave === 'sine' ? 'sawtooth' : wave, 1, -4, 0.42); add('sine', 0.5, 0, 0.3); level = 0.9; }
    else if (inst === 'pad') { for (const d of [-19, -7, 7, 19]) add(wave, 1, d, 0.2); add('sine', 0.5, 0, 0.18); level = 0.8; }
    else if (inst === 'acid') { add(wave === 'sine' ? 'sawtooth' : wave, 1, 0, 0.55); add('square', 1, 6, 0.18); add('sine', 0.5, 0, 0.25); }
    else if (inst === 'perc') {
      const o = add('sine', 1, 0, 0.8); o.detune.setValueAtTime(900, t0); o.detune.setTargetAtTime(0, t0, 0.014);
      add('triangle', 2.01, 0, 0.12);
    } else if (inst === 'fm') {
      const car = add('sine', 1, 0, 0.7);
      const mod = c.createOscillator(); mod.type = 'sine';
      const mg = c.createGain(); mg.gain.setValueAtTime(f0 * 3.2, t0); mg.gain.setTargetAtTime(f0 * 0.3, t0, 0.3);
      mod.connect(mg); mg.connect(car.frequency); oscs.push({ o: mod, mul: 2 }); nodes.push(mod, mg);
      add('sine', 3.99, 0, 0.12);
    } else { for (const d of [-13, 0, 13]) add(wave, 1, d, 0.34); }

    // filter with an envelope sweep
    const sweep = { lead: [2.2, 0.25], bass: [3, 0.15], pad: [1.5, 0.8], acid: [7, 0.2] }[inst] || [1, 0.1];
    const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.Q.value = track.res || 0;
    const cut = Math.min(18000, Math.max(60, (track.cutoff || 4000) * Math.min(3, Math.max(0.6, Math.sqrt(f0 / 330)))));
    filt.frequency.setValueAtTime(Math.min(18000, cut * sweep[0]), t0);
    if (sweep[0] > 1) filt.frequency.setTargetAtTime(cut, t0, sweep[1] / 3);
    // amplitude envelope (analytic value at note end avoids clicks)
    const env = c.createGain();
    const peak = 0.26 * vel * level;
    const a = Math.max(track.a, 0.004), dd = Math.max(track.d, 0.01), s = track.s, rel = Math.max(track.r, 0.03);
    env.gain.setValueAtTime(0, t0);
    let vEnd;
    if (t1 <= t0 + a) { vEnd = (peak * (t1 - t0)) / a; env.gain.linearRampToValueAtTime(vEnd, t1); }
    else {
      env.gain.linearRampToValueAtTime(peak, t0 + a);
      env.gain.setTargetAtTime(peak * s, t0 + a, dd / 3);
      vEnd = peak * s + (peak - peak * s) * Math.exp(-(t1 - t0 - a) / (dd / 3));
    }
    env.gain.setValueAtTime(vEnd, t1);
    env.gain.setTargetAtTime(0, t1, rel / 4);
    const stopAt = t1 + rel * 1.7 + 0.06;
    const kill = c.createGain();
    out.connect(filt); filt.connect(env); env.connect(kill); kill.connect(bus.in);
    nodes.push(filt, env, kill);
    automate(oscs);
    const voice = {
      t0, dead: false, track: track.id,
      kill: (t) => {
        if (voice.dead) return;
        voice.dead = true;
        kill.gain.setTargetAtTime(0, t, 0.008);
        for (const x of oscs) { try { x.o.stop(t + 0.06); } catch (e) { /* ignore */ } }
      },
      onEnd: null,
    };
    let remaining = oscs.length;
    for (const x of oscs) {
      x.o.start(t0); x.o.stop(stopAt);
      x.o.onended = () => {
        if (--remaining > 0) return;
        voice.dead = true;
        for (const n of nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
        this.voices.delete(voice); this.ended++;
        if (voice.onEnd) voice.onEnd();
      };
    }
    return this._track(voice);
  }

  playNote(track, { t0, t1, midi, vel = 0.8 }) {
    const f0 = midiToFreq(midi);
    return this._voice(track, t0, t1, vel, f0, (oscs) => { for (const x of oscs) x.o.frequency.setValueAtTime(f0 * x.mul, t0); });
  }

  // `values` are Hz sampled evenly across [t0, t1].
  playCurve(track, { t0, t1, values, vel = 0.8 }) {
    if (t1 - t0 < 0.01 || values.length < 2) return null;
    return this._voice(track, t0, t1, vel, values[0], (oscs) => {
      const cache = new Map();
      for (const x of oscs) {
        let arr = cache.get(x.mul);
        if (!arr) { arr = new Float32Array(values.length); for (let i = 0; i < values.length; i++) arr[i] = values[i] * x.mul; cache.set(x.mul, arr); }
        x.o.frequency.setValueAtTime(arr[0], t0);
        x.o.frequency.setValueCurveAtTime(arr, t0, t1 - t0);
      }
    });
  }

  // Live monitor tone while drawing (single oscillator following the pointer).
  monitorStart(track, freq) {
    this.monitorStop();
    const bus = this.buses.get(track.id);
    if (!bus) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = track.wave === 'sawtooth' ? 'triangle' : track.wave;
    o.frequency.value = freq;
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.14, t + 0.02);
    o.connect(g); g.connect(bus.in); o.start(t);
    this.monitor = { o, g };
  }
  monitorSet(freq) { if (this.monitor) this.monitor.o.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.02); }
  monitorStop() {
    const m = this.monitor; if (!m) return;
    this.monitor = null;
    const t = this.ctx.currentTime;
    m.g.gain.cancelScheduledValues(t); m.g.gain.setTargetAtTime(0, t, 0.02);
    try { m.o.stop(t + 0.15); } catch (e) { /* ignore */ }
    m.o.onended = () => { try { m.o.disconnect(); m.g.disconnect(); } catch (e) { /* ignore */ } };
  }

  preview(track, midi, seconds = 0.35) {
    const t = this.ctx.currentTime + 0.005;
    return this.playNote(track, { t0: t, t1: t + seconds, midi, vel: 0.8 });
  }

  killAll() {
    const t = this.ctx.currentTime;
    for (const v of [...this.voices]) v.kill(t);
    this.monitorStop();
  }
  stats() { return { active: this.voices.size, created: this.created, ended: this.ended }; }

  // ---- drums ----
  _noise(t, dur) {
    const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
    return s;
  }
  playDrum(laneId, t, vel = 1) {
    const bus = this.buses.get('drums');
    if (!bus || !bus.audible) return;
    const c = this.ctx, dest = bus.in;
    const tail = (nodes, end) => { const last = nodes[0]; last.onended = () => { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } } }; return end; };
    const env = (peak, decay, at = t) => {
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(peak * vel, at + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0008, at + decay);
      g.connect(dest); return g;
    };
    const osc = (type, f0, f1, tf, g, dur) => {
      const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + tf);
      o.connect(g); o.start(t); o.stop(t + dur + 0.03); o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
    };
    const noiseHit = (type, freq, q, peak, decay, at = t) => {
      const n = this._noise(at, decay), f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = env(peak, decay, at); n.connect(f); f.connect(g);
      n.onended = () => { try { n.disconnect(); f.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
      return g;
    };
    switch (laneId) {
      case 'kick': osc('sine', 170, 42, 0.11, env(1.1, 0.5), 0.5); noiseHit('lowpass', 1800, 0.7, 0.25, 0.012); break;
      case 'snare': osc('triangle', 200, 140, 0.08, env(0.45, 0.14), 0.14); noiseHit('highpass', 1400, 0.7, 0.7, 0.2); break;
      case 'clap': [0, 0.013, 0.027].forEach((d) => noiseHit('bandpass', 1500, 1.1, 0.6, 0.02, t + d)); noiseHit('bandpass', 1400, 0.9, 0.5, 0.2, t + 0.04); break;
      case 'hatc': if (this.openHat) { const o = this.openHat; this.openHat = null; o.gain.cancelScheduledValues(t); o.gain.setTargetAtTime(0, t, 0.004); } noiseHit('highpass', 7500, 0.6, 0.38, 0.055); break;
      case 'hato': this.openHat = noiseHit('highpass', 7000, 0.6, 0.34, 0.38); break;
      case 'perc': osc('sine', 420, 190, 0.07, env(0.7, 0.22), 0.22); osc('triangle', 1200, 900, 0.02, env(0.2, 0.03), 0.03); break;
      default: break;
    }
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }
}
