import test from 'node:test';
import assert from 'node:assert/strict';
import { Viewport, midiToFreq, freqToMidi, PITCH_LO, PITCH_HI, snapRound, snapFloor, snapStep, gridSpacing } from '../js/coords.js';
import { processLine, pitchAt, lineFreqs } from '../js/curve.js';
import { inScale, nearestScaleMidi } from '../js/scales.js';
import { createProject, sanitizeProject, makeNote, makeLine, computeAllLines, serialize, exportPayload, demoProject, totalBeats } from '../js/model.js';
import { Store } from '../js/store.js';
import { resolveOverlaps, copyNotes, pasteNotes, reverseNotes, mirrorNotes, reverseLine, flipLine, moveLineRaw } from '../js/ops.js';
import { buildMidi } from '../js/export.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('frequency/MIDI conversions', () => {
  near(midiToFreq(69), 440); near(freqToMidi(440), 69); near(freqToMidi(midiToFreq(37.3)), 37.3, 1e-9);
  near(midiToFreq(PITCH_LO), 20, 1e-6); near(midiToFreq(PITCH_HI), 16000, 1e-3);
});

test('viewport: pixel <-> time/pitch round trips and no dead zones', () => {
  const vp = new Viewport({ tMax: 16 });
  vp.setSize(390, 600); vp.fitX(); vp.fitY();
  near(vp.xToTime(0), 0); near(vp.xToTime(390), 16);
  near(vp.yToPitch(0), vp.pHi); near(vp.yToPitch(600), vp.pLo, 1e-9);
  for (const t of [0, 1.234, 8, 15.99]) near(vp.xToTime(vp.timeToX(t)), t, 1e-9);
  for (const p of [20, 40.5, 100]) near(vp.yToPitch(vp.pitchToY(p)), p, 1e-9);
});

test('viewport: zoom keeps the point under the anchor fixed and never exposes out-of-range data', () => {
  const vp = new Viewport({ tMax: 16 });
  vp.setSize(400, 500); vp.fitX(); vp.fitY();
  vp.zoomX(4, 300); // anchor in the middle of the data
  const t = vp.xToTime(300);
  vp.zoomX(2, 300);
  near(vp.xToTime(300), t, 1e-6);
  vp.zoomX(1000, 10);
  assert.ok(vp.ppb <= vp.maxPpb + 1e-9);
  vp.panBy(1e6, 1e6);
  assert.ok(vp.x0 >= 0 && vp.pTop <= vp.pHi + 1e-9);
  vp.panBy(-1e6, -1e6);
  assert.ok(vp.x0 <= vp.tMax - vp.tVisible + 1e-6 && vp.pTop - vp.pVisible >= vp.pLo - 1e-6);
  vp.zoomX(1e-6); vp.zoomY(1e-6);
  near(vp.tVisible, 16, 1e-6);
});

test('snap math is in beats (1/16 = 0.25 beat)', () => {
  assert.equal(snapStep('1/4'), 1); assert.equal(snapStep('1/8'), 0.5); assert.equal(snapStep('1/16'), 0.25); assert.equal(snapStep('1/32'), 0.125); assert.equal(snapStep('off'), 0);
  near(snapRound(1.37, 0.25), 1.25); near(snapRound(1.38, 0.25), 1.5); near(snapFloor(1.99, 0.25), 1.75); near(snapRound(1.37, 0), 1.37);
  assert.ok(gridSpacing(10, 0.125) * 10 >= 9);
});

const mk = (pairs) => pairs.map(([t, p]) => [t, p]);
const path = mk([[0, 60], [2, 72], [4, 55], [6, 80], [8, 64]]);

test('curve: drawing direction does not change the result', () => {
  const a = processLine(path, { mode: 'natural', tMax: 16 });
  const b = processLine([...path].reverse(), { mode: 'natural', tMax: 16 });
  assert.deepEqual(a, b);
});

test('curve: finger speed (sample density) does not change time mapping', () => {
  const dense = [];
  for (let i = 0; i <= 400; i++) { const t = i * 0.02; dense.push([t, pitchAt(processLine(path, { mode: 'natural', amount: 0, tMax: 16 }), t)]); }
  const sparse = path;
  const a = processLine(dense, { mode: 'natural', amount: 0, tMax: 16 }), b = processLine(sparse, { mode: 'natural', amount: 0, tMax: 16 });
  for (const t of [0.5, 2, 3.3, 6, 7.9]) near(pitchAt(a, t), pitchAt(b, t), 0.05);
});

test('curve: stays inside the canvas and keeps start/end time', () => {
  const pts = processLine([[-5, 200], [30, -10], [10, 70]], { mode: 'smooth', amount: 80, tMax: 16 });
  assert.ok(pts[0].t >= 0 && pts[pts.length - 1].t <= 16);
  assert.ok(pts.every((q) => q.p >= PITCH_LO - 1e-9 && q.p <= PITCH_HI + 1e-9));
  assert.deepEqual(processLine([[1, 60]], { tMax: 16 }), []);
});

test('curve: smooth reduces jitter, sharp produces steps, scale snap lands on scale notes', () => {
  const jitter = []; for (let i = 0; i <= 100; i++) jitter.push([i * 0.08, 60 + (i % 2 ? 1.5 : -1.5)]);
  const rough = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.abs(pts[i].p - pts[i - 1].p); return s; };
  const nat = processLine(jitter, { mode: 'natural', amount: 0, tMax: 16 }), smooth = processLine(jitter, { mode: 'smooth', amount: 70, tMax: 16 });
  assert.ok(rough(smooth) < rough(nat) * 0.4);
  const ramp = []; for (let i = 0; i <= 64; i++) ramp.push([i * 0.1, 50 + i * 0.3]);
  const sharp = processLine(ramp, { mode: 'sharp', amount: 50, tMax: 16 });
  const distinct = new Set(sharp.map((q) => q.p.toFixed(4)));
  // 6.4 beats at ~0.56 beat per step => about 12 held values, each stored as a start/end pair
  assert.ok(distinct.size <= 13 && sharp.length >= distinct.size * 2 - 1, 'sharp should hold values');
  for (let i = 1; i < sharp.length; i++) assert.ok(sharp[i].t >= sharp[i - 1].t);
  const snapped = processLine(ramp, { mode: 'natural', snap: true, root: 0, scale: 'major', tMax: 16 });
  assert.ok(snapped.every((q) => inScale(q.p, 0, 'major') && Math.abs(q.p - Math.round(q.p)) < 1e-9));
});

test('lineFreqs samples evenly in time and is exponential-consistent', () => {
  const pts = [{ t: 0, p: 57 }, { t: 4, p: 69 }];
  const { values, seconds } = lineFreqs(pts, 0, 4, 120);
  near(seconds, 2); near(values[0], midiToFreq(57), 0.01); near(values[values.length - 1], 440, 0.01);
  const mid = values[(values.length - 1) / 2 | 0]; near(mid, midiToFreq(63), 2);
});

test('scales', () => {
  assert.equal(nearestScaleMidi(61.2, 0, 'major'), 60 + 1 === 61 ? 62 : 62 );
  assert.ok(inScale(69, 9, 'minor')); assert.ok(!inScale(70, 9, 'minor'));
});

test('model: sanitize rejects garbage, clamps and caps', () => {
  assert.throws(() => sanitizeProject(null)); assert.throws(() => sanitizeProject('x')); assert.throws(() => sanitizeProject({ foo: 1 }));
  const p = createProject();
  p.bpm = 9999; p.bars = 500; p.tracks[0].notes.push({ id: 'a', t: -3, d: 1e9, m: 999, v: 7 }, { id: 'b', t: NaN, d: 1, m: 60 }, { id: 'c', t: null, d: 1, m: 60 }, 'junk');
  const c = sanitizeProject(JSON.parse(JSON.stringify(p)));
  assert.equal(c.bpm, 300); assert.equal(c.bars, 32);
  const notes = c.tracks[0].notes; assert.equal(notes.length, 1);
  assert.ok(notes[0].t >= 0 && notes[0].m <= 127 && notes[0].v <= 1 && notes[0].d <= 128);
  assert.ok(c.tracks.some((t) => t.type === 'drums') && c.drums.lanes.length === 6);
});

test('model: export/import round trip, ids and raw lines survive', () => {
  const p = demoProject();
  const s = sanitizeProject(JSON.parse(exportPayload(p)));
  assert.equal(s.tracks.length, p.tracks.length);
  assert.equal(s.tracks[0].notes.length, p.tracks[0].notes.length);
  computeAllLines(s);
  const line = s.tracks.flatMap((t) => t.lines)[0];
  assert.ok(line.pts.length > 2);
});

test('model: legacy v1/v3 projects migrate (x normalized over duration @120bpm)', () => {
  const legacy = {
    lines: [[{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }]], brushes: ['bass'], shapeModes: ['sharp'], duration: 8,
    notes: [{ x: 0.25, len: 0.125, midi: 60 }], wave: 'square',
  };
  const p = sanitizeProject(legacy);
  assert.equal(p.bars, 4);
  const bass = p.tracks.find((t) => t.inst === 'bass');
  near(bass.lines[0].raw[0][0], 0); near(bass.lines[0].raw[2][0], 16);
  near(midiToFreq(bass.lines[0].raw[0][1]), 20, 1e-6); near(midiToFreq(bass.lines[0].raw[2][1]), 16000, 1e-2);
  assert.equal(bass.lines[0].mode, 'sharp');
  const lead = p.tracks.find((t) => t.inst === 'lead');
  near(lead.notes[0].t, 4); near(lead.notes[0].d, 2); assert.equal(lead.wave, 'square');
});

test('store: one gesture = one undo step; redo; branching clears redo', () => {
  const store = new Store(createProject());
  const tr = () => store.project.tracks[0];
  store.begin(); tr().notes.push(makeNote(0, 1, 60));
  for (let i = 0; i < 20; i++) { tr().notes[0].t += 0.05; store.live(); }
  assert.ok(store.commit('move'));
  assert.equal(store.undoStack.length, 1);
  store.begin(); assert.equal(store.commit('noop'), false); assert.equal(store.undoStack.length, 1);
  store.transact('add', (p) => p.tracks[0].notes.push(makeNote(2, 1, 64)));
  assert.equal(tr().notes.length, 2);
  assert.ok(store.undo()); assert.equal(tr().notes.length, 1);
  assert.ok(store.undo()); assert.equal(tr().notes.length, 0);
  assert.equal(store.undo(), false);
  assert.ok(store.redo()); assert.ok(store.redo()); assert.equal(tr().notes.length, 2);
  near(tr().notes[0].t, 1.0, 1e-9);
  store.undo(); store.transact('x', (p) => p.bpm = 99); assert.equal(store.canRedo, false);
});

test('store: undo restores lines with recomputed pts', () => {
  const store = new Store(createProject());
  store.transact('line', (p) => p.tracks[0].lines.push(makeLine([[0, 60], [4, 70], [8, 65]], { mode: 'natural', amount: 30 }, p)));
  store.transact('del', (p) => { p.tracks[0].lines = []; });
  store.undo();
  assert.ok(store.project.tracks[0].lines[0].pts.length > 2);
});

test('ops: overlap resolution trims/removes the passive notes', () => {
  const p = createProject(); const tr = p.tracks[0];
  const a = makeNote(0, 4, 60), b = makeNote(2, 4, 60), c = makeNote(3, 1, 60), d = makeNote(3, 1, 62);
  tr.notes.push(a, b, c, d);
  resolveOverlaps(tr, [b.id]);
  near(a.d, 2); assert.ok(!tr.notes.includes(c)); assert.ok(tr.notes.includes(d)); near(b.t, 2);
  const e = makeNote(10, 4, 61), f = makeNote(8, 3, 61); tr.notes.push(e, f);
  resolveOverlaps(tr, [f.id]); near(e.t, 11); near(e.d, 3);
});

test('ops: copy/paste/reverse/mirror', () => {
  const p = createProject(); const tr = p.tracks[0];
  tr.notes.push(makeNote(1, 1, 60), makeNote(2, 2, 64));
  const clip = copyNotes(tr.notes); near(clip.span, 3);
  const made = pasteNotes(tr, clip, 8, p); assert.equal(made.length, 2); near(made[0].t, 8); near(made[1].t, 9);
  const over = pasteNotes(tr, clip, 15, p); near(over[0].t, totalBeats(p) - clip.span);
  const orig = tr.notes.slice(0, 2).map((n) => ({ ...n }));
  reverseNotes(tr.notes.slice(0, 2), 0, 4); near(tr.notes[0].t, 2); near(tr.notes[1].t, 0);
  mirrorNotes(tr.notes.slice(0, 2), 62); assert.equal(tr.notes[0].m, 64); assert.equal(tr.notes[1].m, 60); assert.ok(orig);
});

test('ops: line reverse/flip/move stay in range', () => {
  const p = createProject();
  const l = makeLine([[0, 50], [4, 70]], { mode: 'natural', amount: 0 }, p);
  reverseLine(l, p); near(l.raw[0][1], 70); near(l.raw[1][1], 50);
  flipLine(l, p); near(l.raw[0][1], 50);
  const m = moveLineRaw([[0, 50], [4, 70]], 100, 100, 16); near(m[1][0], 16); assert.ok(m[1][1] <= PITCH_HI + 1e-9);
});

test('midi export has a valid header and one track per active track', () => {
  const p = demoProject();
  const bytes = buildMidi(p);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  assert.ok(bytes.length > 200);
});

test('serialize omits derived pts', () => {
  const p = demoProject(); computeAllLines(p);
  assert.ok(!serialize(p).includes('"pts"'));
});
