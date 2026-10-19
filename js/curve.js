// Turns a raw hand-drawn gesture into a function of musical time.
// Input points are [beat, pitch] in the order they were drawn. Direction of
// drawing and speed of the finger are irrelevant: only the (t, p) positions count.
import { PITCH_LO, PITCH_HI, clamp, midiToFreq } from './coords.js';
import { nearestScaleMidi } from './scales.js';

export const RES = 1 / 16; // resampling resolution in beats
export const MODES = ['smooth', 'natural', 'sharp'];

function sanitizeRaw(raw, tMax) {
  const pts = [];
  for (const q of raw) {
    const t = q[0], p = q[1];
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    pts.push([clamp(t, 0, tMax), clamp(p, PITCH_LO, PITCH_HI)]);
  }
  pts.sort((a, b) => a[0] - b[0]); // direction independent
  const out = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(q[0] - last.t) < 1e-4) { last.sum += q[1]; last.n++; last.p = last.sum / last.n; }
    else out.push({ t: q[0], p: q[1], sum: q[1], n: 1 });
  }
  return out.map((o) => [o.t, o.p]);
}

function resample(pts) {
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const n = Math.max(1, Math.round((t1 - t0) / RES));
  const out = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const t = i === n ? t1 : t0 + (i * (t1 - t0)) / n;
    while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
    const a = pts[j], b = pts[j + 1];
    const q = b[0] - a[0] > 1e-9 ? clamp((t - a[0]) / (b[0] - a[0]), 0, 1) : 1;
    out.push({ t, p: a[1] + (b[1] - a[1]) * q });
  }
  return out;
}

function blur(arr, radius, passes) {
  let y = arr.map((s) => s.p);
  const n = y.length;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0, wsum = 0;
      for (let k = -radius; k <= radius; k++) {
        const z = clamp(i + k, 0, n - 1);
        const w = radius + 1 - Math.abs(k);
        sum += y[z] * w; wsum += w;
      }
      next[i] = sum / wsum;
    }
    y = next;
  }
  return arr.map((s, i) => ({ t: s.t, p: y[i] }));
}

/**
 * @param raw   [[t,p],...]
 * @param opt   {mode, amount 0..100, snap (scale snap), root, scale, tMax}
 * @returns     [{t,p},...] time-ordered; sharp mode contains near-vertical steps.
 */
export function processLine(raw, opt) {
  const { mode = 'natural', amount = 35, snap = false, root = 0, scale = 'minor', tMax = 1e9 } = opt || {};
  const clean = sanitizeRaw(raw, tMax);
  if (clean.length < 2 || clean[clean.length - 1][0] - clean[0][0] < RES / 2) return [];
  let s = resample(clean);
  const a = clamp(amount, 0, 100) / 100;
  if (mode === 'smooth') {
    const radius = Math.round(1 + a * 11);
    const last = s[s.length - 1].p;
    s = blur(s, radius, 3);
    s[s.length - 1].p = last;
  } else if (mode === 'natural') {
    const radius = Math.round(a * 3);
    if (radius > 0) {
      const first = s[0].p, last = s[s.length - 1].p;
      s = blur(s, radius, 1);
      s[0].p = first; s[s.length - 1].p = last;
    }
  } else if (mode === 'sharp') {
    const stepBeats = 0.125 + a * 0.875; // 1/32 .. 1 beat per step
    const cell = Math.max(1, Math.round(stepBeats / RES));
    const out = [];
    for (let i = 0; i < s.length; i += cell) {
      const slice = s.slice(i, Math.min(s.length, i + cell));
      const v = slice.reduce((x, q) => x + q.p, 0) / slice.length;
      const tStart = slice[0].t;
      const tEnd = slice[slice.length - 1].t;
      out.push({ t: tStart, p: v });
      out.push({ t: i + cell >= s.length ? tEnd : tEnd + RES - 1e-3, p: v });
    }
    for (let i = 1; i < out.length; i++) if (out[i].t < out[i - 1].t) out[i].t = out[i - 1].t;
    s = out;
  }
  if (snap) s = s.map((q) => ({ t: q.t, p: nearestScaleMidi(q.p, root, scale) }));
  return s.map((q) => ({ t: q.t, p: clamp(q.p, PITCH_LO, PITCH_HI) }));
}

// Pitch at beat t. At duplicate time stamps (a step) the later value wins.
export function pitchAt(pts, t) {
  const n = pts.length;
  if (!n) return 0;
  if (t <= pts[0].t) return pts[0].p;
  if (t >= pts[n - 1].t) return pts[n - 1].p;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const dt = b.t - a.t;
  if (dt < 1e-6) return b.p;
  return a.p + ((b.p - a.p) * (t - a.t)) / dt;
}

export const CURVE_SAMPLES_PER_SEC = 120;

// Frequencies (Hz) for the beat range [b0,b1], evenly spaced in real time.
export function lineFreqs(pts, b0, b1, bpm) {
  const seconds = ((b1 - b0) * 60) / bpm;
  const n = Math.max(2, Math.min(6000, Math.ceil(seconds * CURVE_SAMPLES_PER_SEC) + 1));
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = midiToFreq(pitchAt(pts, b0 + ((b1 - b0) * i) / (n - 1)));
  return { values: arr, seconds };
}

// Keep gesture storage compact.
export function decimate(raw, maxPoints = 900) {
  if (raw.length <= maxPoints) return raw;
  const step = raw.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints - 1; i++) out.push(raw[Math.floor(i * step)]);
  out.push(raw[raw.length - 1]);
  return out;
}
