// Pure editing operations on the project data (no DOM, no audio) — unit-testable.
import { clamp, MIDI_MIN, MIDI_MAX, PITCH_LO, PITCH_HI } from './coords.js';
import { uid, totalBeats, computeLine, isDrums } from './model.js';
import { nearestScaleMidi, shiftByDegrees } from './scales.js';

export const MIN_NOTE = 0.0625;
const EPS = 1e-6;

// After a gesture, notes of the same pitch must not overlap. The notes that
// were just created/moved win; the others are trimmed or removed.
export function resolveOverlaps(track, activeIds) {
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds);
  const drop = new Set();
  const byPitch = new Map();
  for (const n of track.notes) { if (!byPitch.has(n.m)) byPitch.set(n.m, []); byPitch.get(n.m).push(n); }
  for (const group of byPitch.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      if (!active.has(a.id) || drop.has(a.id)) continue;
      for (const b of group) {
        if (a === b || active.has(b.id) || drop.has(b.id)) continue;
        const aEnd = a.t + a.d, bEnd = b.t + b.d;
        if (bEnd <= a.t + EPS || b.t >= aEnd - EPS) continue; // disjoint
        if (b.t < a.t - EPS) { b.d = a.t - b.t; if (b.d < MIN_NOTE) drop.add(b.id); }
        else if (bEnd > aEnd + EPS) { b.d = bEnd - aEnd; b.t = aEnd; if (b.d < MIN_NOTE) drop.add(b.id); }
        else drop.add(b.id);
      }
    }
  }
  if (drop.size) track.notes = track.notes.filter((n) => !drop.has(n.id));
  return drop.size;
}

export function copyNotes(notes) {
  if (!notes.length) return null;
  const t0 = Math.min(...notes.map((n) => n.t));
  const end = Math.max(...notes.map((n) => n.t + n.d));
  return { span: end - t0, items: notes.map((n) => ({ dt: n.t - t0, d: n.d, m: n.m, v: n.v })) };
}

export function pasteNotes(track, clip, at, project) {
  const tMax = totalBeats(project);
  const start = clamp(at, 0, Math.max(0, tMax - clip.span));
  const made = [];
  for (const c of clip.items) {
    const t = start + c.dt;
    if (t >= tMax - EPS) continue;
    made.push({ id: uid(), t, d: Math.min(c.d, tMax - t), m: clamp(c.m, MIDI_MIN, MIDI_MAX), v: c.v });
  }
  track.notes.push(...made);
  return made;
}

export function reverseNotes(notes, t0, t1) {
  for (const n of notes) n.t = clamp(t0 + t1 - (n.t + n.d), 0, Math.max(0, t1 - n.d));
}
export function mirrorNotes(notes, axis) {
  for (const n of notes) n.m = clamp(Math.round(2 * axis - n.m), MIDI_MIN, MIDI_MAX);
}

export function reverseLine(line, project) {
  const ts = line.raw.map((q) => q[0]);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  line.raw = line.raw.map((q) => [t0 + t1 - q[0], q[1]]).sort((a, b) => a[0] - b[0]);
  computeLine(line, project);
}
export function flipLine(line, project) {
  const ps = line.raw.map((q) => q[1]);
  const axis = (Math.min(...ps) + Math.max(...ps)) / 2;
  line.raw = line.raw.map((q) => [q[0], clamp(2 * axis - q[1], PITCH_LO, PITCH_HI)]);
  computeLine(line, project);
}
// Shift a line in time/pitch; offsets are clamped so it stays inside the canvas.
export function moveLineRaw(raw, dt, dp, tMax) {
  const ts = raw.map((q) => q[0]), ps = raw.map((q) => q[1]);
  const lo = -Math.min(...ts), hi = tMax - Math.max(...ts);
  const plo = PITCH_LO - Math.min(...ps), phi = PITCH_HI - Math.max(...ps);
  const dT = clamp(dt, lo, hi), dP = clamp(dp, plo, phi);
  return raw.map((q) => [q[0] + dT, q[1] + dP]);
}

// ---- generative helpers ----
export function mutateNotes(track, project, strength, rnd = Math.random) {
  const { root, type } = project.scale;
  const tMax = totalBeats(project);
  let changed = 0;
  for (const n of track.notes) {
    if (rnd() > strength) continue;
    changed++;
    const r = rnd();
    if (r < 0.55) n.m = clamp(shiftByDegrees(n.m, (rnd() < 0.5 ? -1 : 1) * (1 + Math.floor(rnd() * 2)), root, type), MIDI_MIN, MIDI_MAX);
    else if (r < 0.8) n.d = clamp(n.d * (rnd() < 0.5 ? 0.5 : 2), MIN_NOTE, tMax - n.t);
    else n.t = clamp(n.t + (rnd() < 0.5 ? -0.25 : 0.25), 0, tMax - n.d);
    n.m = clamp(n.m, MIDI_MIN, MIDI_MAX);
  }
  resolveOverlaps(track, new Set(track.notes.map((n) => n.id)));
  return changed;
}

export function harmonize(track, notes, project, degrees = [2, 4]) {
  const { root, type } = project.scale;
  const added = [];
  for (const n of notes) {
    for (const d of degrees) {
      const m = shiftByDegrees(n.m, d, root, type);
      if (m > MIDI_MAX) continue;
      added.push({ id: uid(), t: n.t, d: n.d, m, v: clamp(n.v * 0.7, 0.05, 1) });
    }
  }
  track.notes.push(...added);
  return added;
}

// Root-note bass line: one note per beat-pair following the lowest sounding pitch of the source.
export function bassFromTrack(src, dst, project) {
  const tMax = totalBeats(project);
  const { root, type } = project.scale;
  const added = [];
  for (let t = 0; t < tMax; t += 2) {
    const at = src.notes.filter((n) => n.t < t + 2 && n.t + n.d > t);
    if (!at.length) continue;
    let m = Math.min(...at.map((n) => n.m));
    while (m > 52) m -= 12;
    while (m < 28) m += 12;
    m = nearestScaleMidi(m, root, type);
    added.push({ id: uid(), t, d: 1.75, m, v: 0.9 });
  }
  dst.notes.push(...added);
  return added;
}

export const noteTracks = (p) => p.tracks.filter((t) => !isDrums(t));
