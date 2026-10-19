// Free Draw / Frequency Canvas.
// X = musical time (beats), Y = pitch on a logarithmic frequency axis (linear in MIDI).
// The WHOLE canvas is the plot area: pointer, drawing and audio all go through one Viewport.
import { Viewport, clamp, snapStep, snapRound, gridSpacing, midiToFreq, freqToMidi, PITCH_LO, PITCH_HI, BLACK, noteName } from './coords.js';
import { bindPointers, wheelNavigate } from './gestures.js';
import { totalBeats, isDrums, trackColor, makeLine, computeLine } from './model.js';
import { decimate, processLine } from './curve.js';
import { inScale } from './scales.js';
import { moveLineRaw, reverseLine, flipLine } from './ops.js';
import { uid } from './model.js';

export const COLORS = { bg: '#0a121c', row: '#0e1925', rowScale: '#122234', grid: '#17283a', beat: '#20364b', bar: '#35556f', text: '#7f9bb2', textBright: '#c4d6e4', play: '#ffe08a' };

export function drawTimeGrid(g, vp, step, h, labelTop = true) {
  const sp = gridSpacing(vp.ppb, step || 0.25, 10);
  const t0 = Math.floor(vp.x0 / sp) * sp, t1 = vp.x0 + vp.tVisible;
  g.lineWidth = 1; g.font = '10px -apple-system, system-ui, sans-serif'; g.textBaseline = 'top';
  for (let t = t0; t <= t1 + 1e-9; t += sp) {
    if (t < -1e-9) continue;
    const x = Math.round(vp.timeToX(t)) + 0.5;
    const beat = Math.abs(t - Math.round(t)) < 1e-6, bar = beat && Math.round(t) % 4 === 0;
    g.strokeStyle = bar ? COLORS.bar : beat ? COLORS.beat : COLORS.grid;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    if (labelTop && bar) { g.fillStyle = COLORS.text; g.textAlign = 'left'; g.fillText(String(Math.round(t) / 4 + 1), x + 3, 2); }
  }
}

export function drawPolyline(g, vp, pts, width, color, alpha = 1) {
  if (!pts || pts.length < 2) return;
  g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i < pts.length; i++) { const x = vp.timeToX(pts[i].t), y = vp.pitchToY(pts[i].p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
  g.stroke(); g.globalAlpha = 1;
}

// Distance (px) from point to a polyline given in viewport pixels.
export function distToPolyline(vp, pts, x, y) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ax = vp.timeToX(pts[i - 1].t), ay = vp.pitchToY(pts[i - 1].p), bx = vp.timeToX(pts[i].t), by = vp.pitchToY(pts[i].p);
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const q = l2 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
    const d = Math.hypot(x - (ax + q * dx), y - (ay + q * dy));
    if (d < best) best = d;
  }
  return best;
}

export class FreeDraw {
  constructor(app, canvas) {
    this.app = app; this.c = canvas; this.g = canvas.getContext('2d');
    const total = totalBeats(app.store.project);
    this.vp = new Viewport({ tMax: total, minPpm: 2, maxPpm: 40, maxPpb: 600 });
    this.selected = null; // line id
    this.stroke = null; this.preview = null; this.drag = null; this.erasing = false;
    this.dpr = 1;
    bindPointers(canvas, {
      down: (p, e) => this.down(p, e), move: (p, e, list) => this.move(p, e, list), up: (p, e) => this.up(p, e),
      cancel: () => this.cancelGesture(),
      pinch: (g) => { this.vp.zoomX(g.fx, g.cx); this.vp.zoomY(g.fy, g.cy); this.vp.panBy(g.dx, g.dy); this.app.invalidate(); },
      wheel: (p, e) => { wheelNavigate(this.vp, p, e); this.app.invalidate(); },
      zoomGesture: (p, f) => { this.vp.zoomX(f, p.x); this.vp.zoomY(f, p.y); this.app.invalidate(); },
      hover: (p) => { this.c.style.cursor = this.app.prefs.tool === 'draw' ? 'crosshair' : this.app.prefs.tool === 'erase' ? 'cell' : (this.hitLine(p.x, p.y) ? 'move' : 'default'); },
    });
  }

  get project() { return this.app.store.project; }
  resize(w, h) { this.vp.setTMax(totalBeats(this.project)); this.vp.setSize(w, h); this.app.invalidate(); }
  onProjectChange() {
    this.vp.setTMax(totalBeats(this.project));
    if (this.selected && !this.findLine(this.selected)) this.selected = null;
  }
  findLine(id) { for (const t of this.project.tracks) if (t.lines) for (const l of t.lines) if (l.id === id) return { track: t, line: l }; return null; }

  toData(p) { return [clamp(this.vp.xToTime(p.x), 0, this.vp.tMax), clamp(this.vp.yToPitch(p.y), PITCH_LO, PITCH_HI)]; }
  get touchTol() { return this.lastType === 'touch' || this.lastType === 'pen' ? 20 : 9; }

  hitLine(x, y) {
    const tol = this.touchTol;
    let best = null, bd = tol;
    const active = this.app.activeTrackId;
    for (const tr of this.project.tracks) for (const l of tr.lines || []) {
      if (!l.pts || l.pts.length < 2) continue;
      const d = distToPolyline(this.vp, l.pts, x, y) - (tr.id === active ? 2 : 0);
      if (d < bd) { bd = d; best = { track: tr, line: l }; }
    }
    return best;
  }

  down(p, e) {
    this.lastType = e.pointerType;
    const app = this.app, tool = app.prefs.tool;
    app.audio(); // unlock + create audio inside the user gesture
    if (tool === 'draw') {
      const track = app.activeTrack();
      if (!track) return;
      this.stroke = { raw: [this.toData(p)], last: p, track: track.id };
      if (app.prefs.monitor) { const [, pitch] = this.stroke.raw[0]; app.engine.monitorStart(track, midiToFreq(pitch)); }
    } else if (tool === 'erase') {
      app.store.begin(); this.erasing = true; this.eraseAt(p, p);
    } else {
      const hit = this.hitLine(p.x, p.y);
      if (hit) {
        this.selected = hit.line.id; app.setActiveTrack(hit.track.id);
        app.store.begin();
        this.drag = { id: hit.line.id, x: p.x, y: p.y, raw: hit.line.raw.map((q) => [q[0], q[1]]) };
      } else this.selected = null;
      app.refreshUi();
    }
    app.invalidate();
  }

  move(p, e, list) {
    const app = this.app;
    if (this.stroke) {
      for (const q of list) {
        const last = this.stroke.last;
        if (Math.hypot(q.x - last.x, q.y - last.y) < 0.8) continue;
        this.stroke.raw.push(this.toData(q)); this.stroke.last = q;
      }
      const cur = this.stroke.raw[this.stroke.raw.length - 1];
      if (app.engine) app.engine.monitorSet(midiToFreq(cur[1]));
      this.preview = null; // recomputed lazily when drawing
    } else if (this.erasing) {
      const prev = this.lastErase || p;
      this.eraseAt(prev, p); this.lastErase = p;
    } else if (this.drag) {
      const f = this.findLine(this.drag.id); if (!f) return;
      const vp = this.vp, d = this.drag;
      let dt = (p.x - d.x) / vp.ppb, dp = -(p.y - d.y) / vp.ppm;
      const step = snapStep(app.prefs.snap);
      if (step && !e.shiftKey) { const s0 = d.raw[0][0]; dt = snapRound(s0 + dt, step) - s0; }
      if (f.line.snap) dp = Math.round(dp);
      f.line.raw = moveLineRaw(d.raw, dt, dp, vp.tMax);
      computeLine(f.line, this.project);
      app.store.live();
    }
    app.invalidate();
  }

  up() {
    const app = this.app;
    if (this.stroke) {
      const s = this.stroke; this.stroke = null; this.preview = null;
      if (app.engine) app.engine.monitorStop();
      const raw = decimate(s.raw);
      const opt = this.styleOpts();
      const p = this.project;
      const track = p.tracks.find((t) => t.id === s.track);
      const line = makeLine(raw, opt, p);
      if (track && line.pts.length >= 2) {
        app.store.transact('Лінія', () => { track.lines.push(line); });
        this.selected = line.id;
        app.refreshUi();
      }
    } else if (this.erasing) {
      this.erasing = false; this.lastErase = null;
      app.store.commit('Стерти');
    } else if (this.drag) {
      this.drag = null;
      app.store.commit('Перемістити лінію');
    }
    app.invalidate();
  }

  cancelGesture() {
    if (this.stroke) { this.stroke = null; this.preview = null; if (this.app.engine) this.app.engine.monitorStop(); }
    if (this.erasing || this.drag) { this.erasing = false; this.drag = null; this.app.store.cancel(); }
    this.app.invalidate();
  }

  eraseAt(a, b) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6));
    const r = this.touchTol + 2;
    const doomed = new Set();
    for (let i = 0; i <= n; i++) {
      const x = a.x + ((b.x - a.x) * i) / n, y = a.y + ((b.y - a.y) * i) / n;
      for (const tr of this.project.tracks) for (const l of tr.lines || []) if (l.pts && l.pts.length > 1 && !doomed.has(l.id) && distToPolyline(this.vp, l.pts, x, y) < r) doomed.add(l.id);
    }
    if (!doomed.size) return;
    for (const tr of this.project.tracks) if (tr.lines) tr.lines = tr.lines.filter((l) => !doomed.has(l.id));
    if (doomed.has(this.selected)) this.selected = null;
    this.app.store.live();
  }

  styleOpts() {
    const pr = this.app.prefs, sc = this.project.scale;
    return { mode: pr.mode, amount: pr.amount, snap: pr.snapScale, root: sc.root, scale: sc.type };
  }

  // Change smoothing of the selected line (undoable).
  applyStyleToSelected() {
    const f = this.selected && this.findLine(this.selected);
    if (!f) return false;
    const pr = this.app.prefs;
    this.app.store.transact('Стиль лінії', () => { f.line.mode = pr.mode; f.line.amount = pr.amount; f.line.snap = pr.snapScale; computeLine(f.line, this.project); });
    return true;
  }
  deleteSelected() {
    const f = this.selected && this.findLine(this.selected);
    if (!f) return;
    this.app.store.transact('Видалити лінію', () => { f.track.lines = f.track.lines.filter((l) => l.id !== f.line.id); });
    this.selected = null;
  }
  duplicateSelected() {
    const f = this.selected && this.findLine(this.selected);
    if (!f) return;
    const tMax = this.vp.tMax, ts = f.line.raw.map((q) => q[0]);
    const span = Math.max(...ts) - Math.min(...ts);
    const dt = Math.max(...ts) + span <= tMax ? span : 0;
    const copy = { id: uid(), raw: f.line.raw.map((q) => [q[0] + dt, q[1]]), mode: f.line.mode, amount: f.line.amount, snap: f.line.snap };
    this.app.store.transact('Дублювати лінію', (p) => { computeLine(copy, p); f.track.lines.push(copy); });
    this.selected = copy.id;
  }
  reverseSelected() { const f = this.selected && this.findLine(this.selected); if (f) this.app.store.transact('Віддзеркалити в часі', (p) => reverseLine(f.line, p)); }
  flipSelected() { const f = this.selected && this.findLine(this.selected); if (f) this.app.store.transact('Віддзеркалити по висоті', (p) => flipLine(f.line, p)); }
  nudge(dt, dp) {
    const f = this.selected && this.findLine(this.selected);
    if (!f) return false;
    this.app.store.transact('Зсув лінії', () => { f.line.raw = moveLineRaw(f.line.raw, dt, dp, this.vp.tMax); computeLine(f.line, this.project); });
    return true;
  }

  key(e) {
    const step = snapStep(this.app.prefs.snap) || 0.25;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { this.deleteSelected(); return true; }
    if (!this.selected) return false;
    if (e.key === 'ArrowLeft') return this.nudge(-step, 0);
    if (e.key === 'ArrowRight') return this.nudge(step, 0);
    if (e.key === 'ArrowUp') return this.nudge(0, e.shiftKey ? 12 : 1);
    if (e.key === 'ArrowDown') return this.nudge(0, e.shiftKey ? -12 : -1);
    if (e.key === 'Escape') { this.selected = null; this.app.invalidate(); return true; }
    return false;
  }

  draw() {
    const { g, vp, app } = this;
    const w = vp.w, h = vp.h, project = this.project;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, h);
    // semitone rows (when zoomed) + scale highlight
    const hiP = Math.ceil(vp.yToPitch(0)), loP = Math.floor(vp.yToPitch(h));
    if (vp.ppm >= 7) {
      for (let m = loP; m <= hiP; m++) {
        const y1 = vp.pitchToY(m + 0.5), y2 = vp.pitchToY(m - 0.5);
        const sc = app.prefs.showScale && inScale(m, project.scale.root, project.scale.type);
        if (sc) { g.fillStyle = COLORS.rowScale; g.fillRect(0, y1, w, y2 - y1); }
        else if (BLACK[((m % 12) + 12) % 12]) { g.fillStyle = COLORS.row; g.fillRect(0, y1, w, y2 - y1); }
        if (m % 12 === 0) { g.strokeStyle = COLORS.beat; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Math.round(y2) + 0.5); g.lineTo(w, Math.round(y2) + 0.5); g.stroke(); }
      }
    }
    // log-frequency guide lines
    g.font = '10px -apple-system, system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
    for (const f of [20, 30, 50, 80, 100, 200, 300, 500, 800, 1000, 2000, 3000, 5000, 8000, 10000, 16000]) {
      const y = vp.pitchToY(freqToMidi(f));
      if (y < -2 || y > h + 2) continue;
      const major = f === 20 || f === 100 || f === 1000 || f === 10000 || f === 16000;
      g.strokeStyle = major ? COLORS.beat : COLORS.grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, Math.round(y) + 0.5); g.lineTo(w, Math.round(y) + 0.5); g.stroke();
      if (major || vp.ppm > 6) { g.fillStyle = COLORS.text; g.fillText(f >= 1000 ? f / 1000 + ' kHz' : f + ' Hz', 6, clamp(y - 7, 22, h - 8)); }
    }
    if (vp.ppm >= 12) {
      g.fillStyle = COLORS.text; g.textAlign = 'right';
      for (let m = loP; m <= hiP; m++) if (m % 12 === 0 || vp.ppm >= 22) { const y = vp.pitchToY(m); if (y > 12 && y < h - 4) g.fillText(noteName(m), w - 6, y); }
      g.textAlign = 'left';
    }
    drawTimeGrid(g, vp, snapStep(app.prefs.snap), h);
    // piano-roll notes as thin bars (shared timeline: both editors show everything)
    for (const tr of project.tracks) {
      if (isDrums(tr)) continue;
      const col = trackColor(tr); g.fillStyle = col; g.globalAlpha = tr.mute ? 0.12 : tr.id === app.activeTrackId ? 0.55 : 0.28;
      const th = Math.max(3, Math.min(8, vp.ppm * 0.5));
      for (const n of tr.notes) {
        const x1 = vp.timeToX(n.t), x2 = vp.timeToX(n.t + n.d);
        if (x2 < 0 || x1 > w) continue;
        g.fillRect(x1, vp.pitchToY(n.m) - th / 2, Math.max(2, x2 - x1), th);
      }
    }
    g.globalAlpha = 1;
    // lines
    const sel = this.selected;
    for (const tr of project.tracks) {
      if (!tr.lines) continue;
      const col = trackColor(tr);
      const alpha = tr.mute ? 0.2 : tr.id === app.activeTrackId ? 1 : 0.6;
      for (const l of tr.lines) {
        if (l.id === sel) drawPolyline(g, vp, l.pts, 8, col, 0.22);
        drawPolyline(g, vp, l.pts, l.id === sel ? 3.5 : 2.5, col, alpha);
        if (l.id === sel && l.pts.length) {
          g.fillStyle = '#fff';
          for (const q of [l.pts[0], l.pts[l.pts.length - 1]]) { g.beginPath(); g.arc(vp.timeToX(q.t), vp.pitchToY(q.p), 4, 0, 7); g.fill(); }
        }
      }
    }
    // live stroke (processed exactly like the committed line)
    if (this.stroke) {
      const tr = project.tracks.find((t) => t.id === this.stroke.track);
      const raw = this.stroke.raw;
      if (!this.preview || this.preview.n !== raw.length) this.preview = { n: raw.length, pts: processLine(raw, { ...this.styleOpts(), tMax: vp.tMax }) };
      const col = tr ? trackColor(tr) : '#fff';
      drawPolyline(g, vp, this.preview.pts, 3, col, 1);
      g.globalAlpha = 0.25; g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath();
      raw.forEach((q, i) => { const x = vp.timeToX(q[0]), y = vp.pitchToY(q[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); g.globalAlpha = 1;
    }
    // playhead
    if (app.transport && app.transport.playing) {
      const x = Math.round(vp.timeToX(app.transport.position())) + 0.5;
      g.strokeStyle = COLORS.play; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
  }
}
