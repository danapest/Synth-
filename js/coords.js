// Single source of truth for every coordinate conversion in the app.
// Musical time is ALWAYS stored in beats (quarter notes). Pitch is ALWAYS a
// (possibly fractional) MIDI number. Pixels exist only inside a Viewport.

export const FREQ_MIN = 20;
export const FREQ_MAX = 16000;
export const MIDI_MIN = 12;
export const MIDI_MAX = 127;
export const BEATS_PER_BAR = 4;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const PITCH_LO = freqToMidi(FREQ_MIN);
export const PITCH_HI = freqToMidi(FREQ_MAX);

export const beatsToSeconds = (beats, bpm) => (beats * 60) / bpm;
export const secondsToBeats = (sec, bpm) => (sec * bpm) / 60;
export const barsToBeats = (bars) => bars * BEATS_PER_BAR;

// Snap values are expressed in beats (1 beat = 1/4 note).
export const SNAPS = [
  { id: 'off', label: 'Off', step: 0 },
  { id: '1/4', label: '1/4', step: 1 },
  { id: '1/8', label: '1/8', step: 0.5 },
  { id: '1/16', label: '1/16', step: 0.25 },
  { id: '1/32', label: '1/32', step: 0.125 },
];
export const snapStep = (id) => (SNAPS.find((s) => s.id === id) || SNAPS[0]).step;
export const snapRound = (t, step) => (step ? Math.round(t / step) * step : t);
export const snapFloor = (t, step) => (step ? Math.floor(t / step + 1e-9) * step : t);

export class Viewport {
  constructor({ tMax = 16, pLo = PITCH_LO - 0.5, pHi = PITCH_HI + 0.5, minPpm = 2, maxPpm = 60, maxPpb = 800 } = {}) {
    this.w = 300;
    this.h = 300;
    this.x0 = 0; // beat at the left edge
    this.ppb = 20; // pixels per beat
    this.pTop = pHi; // pitch at the top edge
    this.ppm = 4; // pixels per semitone
    this.tMax = tMax;
    this.pLo = pLo;
    this.pHi = pHi;
    this.minPpm = minPpm;
    this.maxPpm = maxPpm;
    this.maxPpb = maxPpb;
  }
  get minPpb() { return this.w / this.tMax; }
  get minPpmEff() { return Math.max(this.minPpm, this.h / (this.pHi - this.pLo)); }

  timeToX(t) { return (t - this.x0) * this.ppb; }
  xToTime(x) { return x / this.ppb + this.x0; }
  pitchToY(p) { return (this.pTop - p) * this.ppm; }
  yToPitch(y) { return this.pTop - y / this.ppm; }
  get tVisible() { return this.w / this.ppb; }
  get pVisible() { return this.h / this.ppm; }

  setSize(w, h) { this.w = Math.max(1, w); this.h = Math.max(1, h); this.clamp(); }
  setTMax(t) { this.tMax = t; this.clamp(); }
  clamp() {
    this.ppb = clamp(this.ppb, this.minPpb, Math.max(this.minPpb, this.maxPpb));
    this.ppm = clamp(this.ppm, this.minPpmEff, Math.max(this.minPpmEff, this.maxPpm));
    this.x0 = clamp(this.x0, 0, Math.max(0, this.tMax - this.w / this.ppb));
    this.pTop = clamp(this.pTop, this.pLo + this.h / this.ppm, this.pHi);
  }
  // Zoom around a pixel anchor so the data under the anchor does not move.
  zoomX(factor, ax = this.w / 2) {
    const t = this.xToTime(ax);
    this.ppb = clamp(this.ppb * factor, this.minPpb, Math.max(this.minPpb, this.maxPpb));
    this.x0 = t - ax / this.ppb;
    this.clamp();
  }
  zoomY(factor, ay = this.h / 2) {
    const p = this.yToPitch(ay);
    this.ppm = clamp(this.ppm * factor, this.minPpmEff, Math.max(this.minPpmEff, this.maxPpm));
    this.pTop = p + ay / this.ppm;
    this.clamp();
  }
  panBy(dxPx, dyPx) {
    this.x0 -= dxPx / this.ppb;
    this.pTop += dyPx / this.ppm;
    this.clamp();
  }
  fitX() { this.ppb = this.minPpb; this.x0 = 0; this.clamp(); }
  fitY() { this.ppm = this.minPpmEff; this.pTop = this.pHi; this.clamp(); }
  centerPitch(p) { this.pTop = p + this.h / this.ppm / 2; this.clamp(); }
}

// Pick the grid spacing (in beats) that keeps lines at least `minPx` apart.
export function gridSpacing(ppb, preferred, minPx = 9) {
  let s = preferred || 0.125;
  while (s * ppb < minPx && s < 64) s *= 2;
  return s;
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
export const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
