// Composition model: creation, validation, legacy migration. Plain JSON only.
import { INSTRUMENTS, WAVES, DRUM_LANES, DRUM_COLOR } from './presets.js';
import { SCALES } from './scales.js';
import { MODES, processLine } from './curve.js';
import { clamp, freqToMidi, BEATS_PER_BAR, PITCH_LO, PITCH_HI, MIDI_MIN, MIDI_MAX } from './coords.js';

export const LIMITS = { tracks: 16, notes: 4000, lines: 300, raw: 900, bpmMin: 30, bpmMax: 300, barsMin: 1, barsMax: 32 };
export const FORMAT = 'draw-your-sound';
export const VERSION = 2;

let counter = 0;
export const uid = () => (Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6));

const num = (x, def, lo, hi) => (Number.isFinite(+x) && x !== null && x !== '' && x !== true ? clamp(+x, lo, hi) : def);
const str = (x, def, max = 60) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : def);

export const totalBeats = (p) => p.bars * BEATS_PER_BAR;
export const isDrums = (t) => t.type === 'drums';
export const synthTracks = (p) => p.tracks.filter((t) => !isDrums(t));
export const drumTrack = (p) => p.tracks.find(isDrums);

export function createDrums() {
  return { lanes: DRUM_LANES.map((l) => ({ id: l.id, len: 16, steps: new Array(16).fill(0) })) };
}

export function createTrack(inst = 'lead', name) {
  const base = INSTRUMENTS[inst] || INSTRUMENTS.lead;
  return {
    id: uid(), type: 'synth', inst, name: name || base.label,
    wave: base.wave, a: base.a, d: base.d, s: base.s, r: base.r, cutoff: base.cutoff, res: base.res,
    drive: base.drive, vol: base.vol, pan: base.pan, rev: base.rev, dly: base.dly, mute: false, solo: false,
    notes: [], lines: [],
  };
}

export function createDrumTrack() {
  return { id: 'drums', type: 'drums', inst: 'drums', name: 'Drums', vol: 0.85, pan: 0, rev: 0.12, dly: 0.05, mute: false, solo: false };
}

export function createProject(name = 'Новий проєкт') {
  const now = Date.now();
  return {
    v: VERSION, id: uid(), name, created: now, updated: now,
    bpm: 120, bars: 4, scale: { root: 9, type: 'minor' },
    master: { vol: 0.8, reverb: 0.25, delay: 0.2, chorus: 0.25, drive: 0.1 },
    tracks: [createTrack('lead'), createTrack('bass'), createDrumTrack()],
    drums: createDrums(),
  };
}

export const trackColor = (t) => (isDrums(t) ? DRUM_COLOR : (INSTRUMENTS[t.inst] || INSTRUMENTS.lead).color);

// ---- line cache (pts is derived and never persisted) ----
export function computeLine(line, project) {
  line.pts = processLine(line.raw, {
    mode: line.mode, amount: line.amount, snap: line.snap,
    root: project.scale.root, scale: project.scale.type, tMax: totalBeats(project),
  });
  return line;
}
export function computeAllLines(project) {
  for (const t of project.tracks) if (t.lines) for (const l of t.lines) computeLine(l, project);
}
export const serialize = (project) => JSON.stringify(project, (k, v) => (k === 'pts' ? undefined : v));

export function makeLine(raw, opt, project) {
  const line = { id: uid(), raw: raw.map((q) => [+q[0], +q[1]]), mode: opt.mode, amount: opt.amount, snap: !!opt.snap };
  computeLine(line, project);
  return line;
}
export function makeNote(t, d, m, v = 0.8) { return { id: uid(), t, d, m, v }; }

// ---- validation ----
function cleanTrack(raw, tMax, seen) {
  if (!raw || typeof raw !== 'object') return null;
  const drums = raw.type === 'drums';
  const base = INSTRUMENTS[raw.inst] ? INSTRUMENTS[raw.inst] : INSTRUMENTS.lead;
  let id = str(raw.id, uid(), 40);
  if (drums) id = 'drums'; else if (seen.has(id) || id === 'drums') id = uid();
  seen.add(id);
  const common = {
    id, type: drums ? 'drums' : 'synth', inst: drums ? 'drums' : (INSTRUMENTS[raw.inst] ? raw.inst : 'lead'),
    name: str(raw.name, drums ? 'Drums' : base.label, 30),
    vol: num(raw.vol, base.vol, 0, 1), pan: num(raw.pan, 0, -1, 1),
    rev: num(raw.rev, base.rev, 0, 1), dly: num(raw.dly, base.dly, 0, 1),
    mute: !!raw.mute, solo: !!raw.solo,
  };
  if (drums) return common;
  const t = {
    ...common,
    wave: WAVES.includes(raw.wave) ? raw.wave : base.wave,
    a: num(raw.a, base.a, 0.001, 4), d: num(raw.d, base.d, 0.005, 4), s: num(raw.s, base.s, 0, 1), r: num(raw.r, base.r, 0.01, 6),
    cutoff: num(raw.cutoff, base.cutoff, 80, 18000), res: num(raw.res, base.res, 0, 24), drive: num(raw.drive, base.drive, 0, 1),
    notes: [], lines: [],
  };
  const ids = new Set();
  for (const n of Array.isArray(raw.notes) ? raw.notes : []) {
    if (!n || t.notes.length >= LIMITS.notes) continue;
    if (![n.t, n.d, n.m].every((v) => v !== null && Number.isFinite(+v))) continue;
    const start = clamp(+n.t, 0, tMax);
    const nid = typeof n.id === 'string' && !ids.has(n.id) ? n.id : uid();
    ids.add(nid);
    t.notes.push({ id: nid, t: start, d: clamp(+n.d, 0.03125, Math.max(0.03125, tMax - start)), m: clamp(Math.round(+n.m), MIDI_MIN, MIDI_MAX), v: num(n.v, 0.8, 0.05, 1) });
  }
  for (const l of Array.isArray(raw.lines) ? raw.lines : []) {
    if (!l || !Array.isArray(l.raw) || t.lines.length >= LIMITS.lines) continue;
    const pts = [];
    for (const q of l.raw.slice(0, LIMITS.raw * 2)) {
      if (!Array.isArray(q) || q[0] === null || q[1] === null || !Number.isFinite(+q[0]) || !Number.isFinite(+q[1])) continue;
      pts.push([clamp(+q[0], 0, tMax), clamp(+q[1], PITCH_LO, PITCH_HI)]);
    }
    if (pts.length < 2) continue;
    const lid = typeof l.id === 'string' && !ids.has(l.id) ? l.id : uid();
    ids.add(lid);
    t.lines.push({ id: lid, raw: pts, mode: MODES.includes(l.mode) ? l.mode : 'natural', amount: num(l.amount, 35, 0, 100), snap: !!l.snap });
  }
  return t;
}

function cleanDrums(raw) {
  const out = createDrums();
  if (!raw || !Array.isArray(raw.lanes)) return out;
  for (const lane of out.lanes) {
    const src = raw.lanes.find((l) => l && l.id === lane.id);
    if (!src) continue;
    lane.len = Math.round(num(src.len, 16, 1, 32));
    lane.steps = new Array(lane.len).fill(0);
    if (Array.isArray(src.steps)) for (let i = 0; i < lane.len; i++) { const v = +src.steps[i]; lane.steps[i] = v >= 0.9 ? 1 : v > 0.1 ? 0.5 : 0; }
  }
  return out;
}

function cleanV2(raw) {
  const bars = Math.round(num(raw.bars, 4, LIMITS.barsMin, LIMITS.barsMax));
  const tMax = bars * BEATS_PER_BAR;
  const seen = new Set();
  const tracks = [];
  for (const t of Array.isArray(raw.tracks) ? raw.tracks.slice(0, LIMITS.tracks) : []) {
    const c = cleanTrack(t, tMax, seen);
    if (c && !(c.type === 'drums' && tracks.some((x) => x.type === 'drums'))) tracks.push(c);
  }
  if (!tracks.some((t) => t.type === 'synth')) tracks.unshift(createTrack('lead'));
  if (!tracks.some((t) => t.type === 'drums')) tracks.push(createDrumTrack());
  const m = raw.master || {};
  const sc = raw.scale || {};
  const now = Date.now();
  return {
    v: VERSION, id: str(raw.id, uid(), 40), name: str(raw.name, 'Без назви', 60),
    created: num(raw.created, now, 0, 8.64e15), updated: num(raw.updated, now, 0, 8.64e15),
    bpm: Math.round(num(raw.bpm, 120, LIMITS.bpmMin, LIMITS.bpmMax) * 10) / 10, bars,
    scale: { root: Math.round(num(sc.root, 9, 0, 11)), type: SCALES[sc.type] ? sc.type : 'minor' },
    master: { vol: num(m.vol, 0.8, 0, 1), reverb: num(m.reverb, 0.25, 0, 1), delay: num(m.delay, 0.2, 0, 1), chorus: num(m.chorus, 0.25, 0, 1), drive: num(m.drive, 0.1, 0, 1) },
    tracks, drums: cleanDrums(raw.drums),
  };
}

// Legacy (single-file v1/v3) project: normalized x over `duration` seconds at an implied 120 BPM.
const LEGACY_BRUSH = { lead: 'lead', bass: 'bass', pad: 'pad', acid: 'acid', drum: 'perc' };
function migrateLegacy(raw) {
  const dur = [4, 8, 16].includes(+raw.duration) ? +raw.duration : 8;
  const beats = dur * 2; // 120 bpm => 2 beats per second
  const p = createProject('Імпорт зі старої версії');
  p.bars = Math.max(1, Math.min(LIMITS.barsMax, Math.round(beats / BEATS_PER_BAR)));
  p.tracks = [];
  const byInst = {};
  const trackFor = (inst) => {
    if (!byInst[inst]) { const t = createTrack(inst); if (inst === 'lead' && WAVES.includes(raw.wave)) t.wave = raw.wave; byInst[inst] = t; p.tracks.push(t); }
    return byInst[inst];
  };
  const lines = Array.isArray(raw.lines) ? raw.lines.slice(0, LIMITS.lines) : [];
  lines.forEach((l, i) => {
    if (!Array.isArray(l)) return;
    const brush = Array.isArray(raw.brushes) ? raw.brushes[i] : 'lead';
    const inst = LEGACY_BRUSH[brush] || 'lead';
    const mode = Array.isArray(raw.shapeModes) && raw.shapeModes[i] === 'sharp' ? 'sharp' : 'natural';
    const pts = l.filter((q) => q && Number.isFinite(+q.x) && Number.isFinite(+q.y)).map((q) => [clamp(+q.x, 0, 1) * beats, clamp(freqToMidi(20 * Math.pow(800, 1 - clamp(+q.y, 0, 1))), PITCH_LO, PITCH_HI)]);
    if (pts.length > 1) trackFor(inst).lines.push({ id: uid(), raw: pts.slice(0, LIMITS.raw), mode, amount: 35, snap: false });
  });
  const notes = Array.isArray(raw.notes) ? raw.notes.slice(0, LIMITS.notes) : [];
  for (const n of notes) {
    if (!n || ![n.x, n.len, n.midi].every((v) => Number.isFinite(+v))) continue;
    const t = clamp(+n.x, 0, 1) * beats;
    trackFor('lead').notes.push({ id: uid(), t, d: clamp(+n.len * beats, 0.03125, beats - t), m: clamp(Math.round(+n.midi), MIDI_MIN, MIDI_MAX), v: 0.8 });
  }
  if (!p.tracks.length) p.tracks.push(createTrack('lead'));
  p.tracks.push(createDrumTrack());
  return p;
}

// Accepts exported wrapper, bare v2 project, or legacy payload. Throws on garbage.
export function sanitizeProject(input) {
  let raw = input;
  if (raw && typeof raw === 'object' && raw.format === FORMAT && raw.project) raw = raw.project;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Це не файл проєкту Draw Your Sound');
  if (raw.v === VERSION && Array.isArray(raw.tracks)) return cleanV2(raw);
  if (Array.isArray(raw.lines) || Array.isArray(raw.notes)) return cleanV2(migrateLegacy(raw));
  throw new Error('Невідомий формат проєкту');
}

export function exportPayload(project) {
  return JSON.stringify({ format: FORMAT, version: VERSION, exported: new Date().toISOString(), project: JSON.parse(serialize(project)) }, null, 1);
}

export function demoProject() {
  const p = createProject('Приклад');
  p.bpm = 110;
  const lead = p.tracks[0], bass = p.tracks[1];
  const A = 69;
  const seq = [[0, 1, A], [1, 0.5, A + 3], [1.5, 0.5, A + 7], [2, 1, A + 5], [3, 1, A + 3], [4, 1, A + 7], [5, 0.5, A + 10], [5.5, 0.5, A + 12], [6, 2, A + 7], [8, 1, A], [9, 1, A + 3], [10, 2, A + 7], [12, 1, A + 5], [13, 1, A + 3], [14, 2, A + 2]];
  for (const [t, d, m] of seq) lead.notes.push(makeNote(t, d, m, 0.8));
  for (let i = 0; i < 8; i++) bass.notes.push(makeNote(i * 2, 1.5, [45, 45, 41, 43][i % 4], 0.9));
  const pad = createTrack('pad');
  const wave = []; for (let i = 0; i <= 48; i++) wave.push([i / 3, 76 + 5 * Math.sin(i / 7)]);
  pad.lines.push({ id: uid(), raw: wave, mode: 'smooth', amount: 60, snap: false });
  const acid = createTrack('acid');
  const zig = []; for (let i = 0; i <= 64; i++) zig.push([8 + i / 8, 52 + 14 * Math.abs(Math.sin(i / 5))]);
  acid.lines.push({ id: uid(), raw: zig, mode: 'sharp', amount: 40, snap: true });
  p.tracks.splice(2, 0, pad, acid);
  const d = p.drums.lanes;
  const fill = (id, s) => { const l = d.find((x) => x.id === id); l.steps = [...s].map(Number); };
  fill('kick', '1000100010001000'); fill('snare', '0000100000001000'); fill('hatc', '1010101010101011'); fill('hato', '0000000100000000');
  return sanitizeProject(JSON.parse(serialize(p)));
}
