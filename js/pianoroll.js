// Piano Roll: FL-Studio-style note editor adapted to mouse, trackpad and touch.
// Notes live in the shared project (beats + MIDI pitch) and are never normalized to pixels.
import { Viewport, clamp, snapStep, snapRound, snapFloor, MIDI_MIN, MIDI_MAX, BLACK, noteName, midiToFreq } from './coords.js';
import { bindPointers, wheelNavigate } from './gestures.js';
import { totalBeats, isDrums, trackColor, makeNote } from './model.js';
import { inScale, nearestScaleMidi } from './scales.js';
import { resolveOverlaps, copyNotes, pasteNotes, reverseNotes, mirrorNotes, MIN_NOTE } from './ops.js';
import { COLORS, drawTimeGrid, drawPolyline } from './freedraw.js';

export const KEYW = 52;
export const RULER = 24;

export class PianoRoll {
  constructor(app, canvas) {
    this.app = app; this.c = canvas; this.g = canvas.getContext('2d');
    this.vp = new Viewport({ tMax: totalBeats(app.store.project), pLo: MIDI_MIN - 0.5, pHi: MIDI_MAX + 0.5, minPpm: 16, maxPpm: 60, maxPpb: 700 });
    this.vp.ppm = matchMedia('(pointer: coarse)').matches ? 28 : 22;
    this.vp.ppb = 56;
    this.sel = new Set();
    this.marker = 0;
    this.clip = null;
    this.lastLen = 0.5;
    this.drag = null;
    this.dpr = 1;
    this.centered = false;
    bindPointers(canvas, {
      down: (p, e) => this.down(p, e), move: (p, e) => this.move(p, e), up: (p, e) => this.up(p, e),
      cancel: () => this.cancelGesture(),
      secondary: (p, e) => this.secondary(p, e),
      pinch: (g) => { this.vp.zoomX(g.fx, g.cx - KEYW); this.vp.zoomY(g.fy, g.cy - RULER); this.vp.panBy(g.dx, g.dy); this.app.invalidate(); },
      wheel: (p, e) => { wheelNavigate(this.vp, { x: p.x - KEYW, y: p.y - RULER }, e); this.app.invalidate(); },
      zoomGesture: (p, f) => { this.vp.zoomX(f, p.x - KEYW); this.app.invalidate(); },
      hover: (p, e) => this.hover(p, e),
    });
  }

  get project() { return this.app.store.project; }
  get track() { return this.app.activeTrack(); }
  get step() { return snapStep(this.app.prefs.snap); }
  get minLen() { return this.step || MIN_NOTE; }
  get tMax() { return this.vp.tMax; }

  resize(w, h) {
    this.vp.setTMax(totalBeats(this.project));
    this.vp.setSize(Math.max(10, w - KEYW), Math.max(10, h - RULER));
    if (!this.centered) { this.vp.centerPitch(66); this.vp.ppb = Math.max(this.vp.minPpb, Math.min(90, this.vp.w / Math.min(this.tMax, 8))); this.vp.clamp(); this.centered = true; }
    this.app.invalidate();
  }
  onProjectChange() {
    this.vp.setTMax(totalBeats(this.project));
    const tr = this.track; const ids = new Set(tr ? tr.notes.map((n) => n.id) : []);
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.marker = clamp(this.marker, 0, this.tMax);
  }
  notesOf(ids = this.sel) { const tr = this.track; return tr ? tr.notes.filter((n) => ids.has(n.id)) : []; }

  // ---- geometry / hit testing ----
  rect(n) { const vp = this.vp; return { x1: vp.timeToX(n.t), x2: vp.timeToX(n.t + n.d), y1: vp.pitchToY(n.m + 0.5), y2: vp.pitchToY(n.m - 0.5) }; }
  isTouch(e) { return e && (e.pointerType === 'touch' || e.pointerType === 'pen'); }

  // Returns {note, zone:'body'|'resize'} with tolerance appropriate for finger vs cursor.
  hit(vx, vy, touch) {
    const tr = this.track; if (!tr) return null;
    const tolX = touch ? 16 : 5, tolY = touch ? 6 : 1;
    let best = null;
    for (const n of tr.notes) {
      const r = this.rect(n);
      const dx = Math.max(r.x1 - vx, 0, vx - r.x2), dy = Math.max(r.y1 - vy, 0, vy - r.y2);
      if (dx > tolX || dy > tolY) continue;
      const d = Math.hypot(dx, dy * 1.6) - (this.sel.has(n.id) ? 0.01 : 0);
      if (!best || d < best.d || (d === best.d && n.t >= best.n.t)) best = { n, d, r };
    }
    if (!best) return null;
    const w = best.r.x2 - best.r.x1;
    const zone = Math.min(clamp(w * 0.38, touch ? 16 : 7, touch ? 30 : 12), w * 0.5 + 1);
    const resize = vx > best.r.x2 || vx >= best.r.x2 - zone;
    return { note: best.n, zone: resize ? 'resize' : 'body' };
  }

  pointToData(vx, vy) { return { t: this.vp.xToTime(vx), m: Math.round(this.vp.yToPitch(vy)) }; }
  snapNoteStart(t) { return clamp(snapFloor(t, this.step), 0, this.tMax - this.minLen); }

  hover(p, e) {
    const vx = p.x - KEYW, vy = p.y - RULER;
    if (p.x < KEYW || p.y < RULER) { this.c.style.cursor = 'pointer'; return; }
    const tool = this.app.prefs.tool;
    const h = this.hit(vx, vy, false);
    this.c.style.cursor = tool === 'erase' ? 'cell' : h ? (h.zone === 'resize' ? 'ew-resize' : 'grab') : tool === 'draw' ? 'crosshair' : 'default';
  }

  // ---- gestures ----
  down(p, e) {
    const app = this.app, tool = app.prefs.tool, touch = this.isTouch(e);
    app.audio();
    const tr = this.track; if (!tr) return;
    this.mods = { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey, alt: e.altKey };
    if (p.y < RULER && p.x >= KEYW) { this.drag = { kind: 'ruler' }; this.setMarker(this.vp.xToTime(p.x - KEYW)); return; }
    if (p.x < KEYW) { this.drag = { kind: 'keys', m: -1 }; this.keyPreview(p); return; }
    const vx = p.x - KEYW, vy = p.y - RULER;
    const h = this.hit(vx, vy, touch);
    if (tool === 'erase') {
      app.store.begin(); this.drag = { kind: 'erase' }; this.eraseAt(vx, vy, touch); return;
    }
    if (h) {
      const n = h.note;
      app.store.begin();
      if (this.mods.shift || this.mods.meta) {
        if (this.sel.has(n.id)) { this.sel.delete(n.id); this.drag = { kind: 'none' }; app.refreshUi(); return; }
        this.sel.add(n.id);
      } else if (!this.sel.has(n.id)) { this.sel = new Set([n.id]); }
      app.refreshUi();
      if (h.zone === 'resize') {
        const group = this.notesOf();
        this.drag = { kind: 'resize', id: n.id, orig: new Map(group.map((q) => [q.id, q.d])), end0: n.t + n.d, moved: false };
      } else {
        if (app.prefs.dupMode || this.mods.alt) {
          const clones = this.notesOf().map((q) => ({ ...q, id: makeNote(0, 0, 0).id }));
          tr.notes.push(...clones);
          const map = new Map(); this.notesOf().forEach((q, i) => map.set(q.id, clones[i]));
          const anchor = map.get(n.id);
          this.sel = new Set(clones.map((c) => c.id));
          this.drag = this.moveState(anchor, p, vx, vy);
        } else this.drag = this.moveState(n, p, vx, vy);
      }
      app.invalidate();
      this.keyPreviewMidi(n.m);
      return;
    }
    // empty space
    if (tool === 'draw') {
      app.store.begin();
      const d = this.pointToData(vx, vy);
      const t0 = this.snapNoteStart(d.t);
      const m = clamp(app.prefs.snapScale ? nearestScaleMidi(d.m, this.project.scale.root, this.project.scale.type) : d.m, MIDI_MIN, MIDI_MAX);
      const len = clamp(this.lastLen, this.minLen, this.tMax - t0);
      const note = makeNote(t0, len, m, 0.8);
      tr.notes.push(note); this.sel = new Set([note.id]);
      this.drag = { kind: 'create', id: note.id, t0, x: p.x, dragged: false };
      this.setMarker(t0, false);
      app.refreshUi(); app.invalidate();
      this.keyPreviewMidi(m);
    } else {
      this.drag = { kind: 'marquee', x0: vx, y0: vy, x: vx, y: vy, additive: this.mods.shift || this.mods.meta, base: new Set(this.sel), moved: false };
      if (!this.drag.additive) { this.sel = new Set(); app.refreshUi(); }
      this.setMarker(snapRound(this.vp.xToTime(vx), this.step), false);
      app.invalidate();
    }
  }

  moveState(anchor, p, vx, vy) {
    const group = this.notesOf();
    return { kind: 'move', id: anchor.id, orig: new Map(group.map((q) => [q.id, { t: q.t, m: q.m, d: q.d }])), t0: this.vp.xToTime(vx) - anchor.t, m0: Math.round(this.vp.yToPitch(vy)), lastM: anchor.m, moved: false, x: p.x, y: p.y };
  }

  move(p, e) {
    const d = this.drag; if (!d) return;
    const app = this.app, vx = p.x - KEYW, vy = p.y - RULER, vp = this.vp, tr = this.track;
    if (d.kind === 'ruler') { this.setMarker(vp.xToTime(vx)); return; }
    if (d.kind === 'keys') { this.keyPreview(p); return; }
    if (d.kind === 'none') return;
    this.autoScroll(vx, vy);
    if (d.kind === 'erase') { this.eraseAt(vx, vy, this.isTouch(e)); return; }
    if (d.kind === 'marquee') {
      d.x = vx; d.y = vy;
      if (Math.hypot(vx - d.x0, vy - d.y0) > 3) d.moved = true;
      const xa = Math.min(d.x0, d.x), xb = Math.max(d.x0, d.x), ya = Math.min(d.y0, d.y), yb = Math.max(d.y0, d.y);
      const hits = new Set(d.additive ? d.base : []);
      for (const n of tr.notes) { const r = this.rect(n); if (r.x2 >= xa && r.x1 <= xb && r.y2 >= ya && r.y1 <= yb) hits.add(n.id); }
      this.sel = hits; app.invalidate(); return;
    }
    const note = tr.notes.find((n) => n.id === d.id); if (!note) return;
    if (d.kind === 'create') {
      if (Math.abs(p.x - d.x) > 4) d.dragged = true;
      if (d.dragged) {
        const t = vp.xToTime(vx);
        const end = this.step ? snapRound(t, this.step) : t;
        note.d = clamp(Math.max(this.minLen, end - d.t0), this.minLen, this.tMax - d.t0);
      }
    } else if (d.kind === 'move') {
      if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < 3) return;
      d.moved = true;
      const a = d.orig.get(d.id);
      let nt = vp.xToTime(vx) - d.t0;
      if (this.step) nt = snapRound(nt, this.step);
      let dT = nt - a.t;
      let dM = Math.round(vp.yToPitch(vy)) - d.m0;
      let loT = -Infinity, hiT = Infinity, loM = -Infinity, hiM = Infinity;
      for (const o of d.orig.values()) { loT = Math.max(loT, -o.t); hiT = Math.min(hiT, this.tMax - o.d - o.t); loM = Math.max(loM, MIDI_MIN - o.m); hiM = Math.min(hiM, MIDI_MAX - o.m); }
      dT = clamp(dT, loT, hiT); dM = clamp(dM, loM, hiM);
      if (app.prefs.snapScale) { const target = nearestScaleMidi(a.m + dM, this.project.scale.root, this.project.scale.type); dM = clamp(target - a.m, loM, hiM); }
      for (const q of tr.notes) { const o = d.orig.get(q.id); if (o) { q.t = o.t + dT; q.m = o.m + dM; } }
      const am = a.m + dM; if (am !== d.lastM) { d.lastM = am; this.keyPreviewMidi(am); }
    } else if (d.kind === 'resize') {
      d.moved = true;
      const t = vp.xToTime(vx);
      const end = this.step ? snapRound(t, this.step) : t;
      const delta = end - d.end0;
      for (const q of tr.notes) { const o = d.orig.get(q.id); if (o !== undefined) q.d = clamp(o + delta, this.minLen, this.tMax - q.t); }
    }
    app.store.live();
  }

  up(p, e) {
    const d = this.drag; this.drag = null;
    const app = this.app, tr = this.track;
    if (!d) return;
    if (d.kind === 'ruler' || d.kind === 'keys') { app.invalidate(); return; }
    if (d.kind === 'marquee') { app.refreshUi(); app.invalidate(); return; }
    if (d.kind === 'none') { app.store.commit(''); return; }
    if (d.kind === 'erase') { app.store.commit('Видалити ноти'); app.refreshUi(); return; }
    if (tr) {
      if (d.kind === 'create') {
        const n = tr.notes.find((q) => q.id === d.id);
        if (n) { this.lastLen = n.d; this.marker = clamp(n.t + n.d, 0, this.tMax); }
        resolveOverlaps(tr, [d.id]);
        app.store.commit('Нова нота');
      } else if (d.kind === 'move' || d.kind === 'resize') {
        if (d.moved) resolveOverlaps(tr, this.sel);
        if (d.kind === 'resize' && d.moved) { const n = tr.notes.find((q) => q.id === d.id); if (n) this.lastLen = n.d; }
        app.store.commit(d.kind === 'move' ? 'Перемістити' : 'Змінити тривалість');
      }
    }
    app.refreshUi(); app.invalidate();
  }

  cancelGesture() {
    const d = this.drag; this.drag = null;
    if (d && ['create', 'move', 'resize', 'erase', 'none'].includes(d.kind)) this.app.store.cancel();
    this.app.invalidate();
  }

  secondary(p) { // right click deletes a note, FL style
    const tr = this.track; if (!tr || p.x < KEYW || p.y < RULER) return;
    const h = this.hit(p.x - KEYW, p.y - RULER, false);
    if (!h) return;
    this.app.store.transact('Видалити ноту', () => { tr.notes = tr.notes.filter((n) => n.id !== h.note.id); });
    this.sel.delete(h.note.id); this.app.refreshUi(); this.app.invalidate();
  }

  eraseAt(vx, vy, touch) {
    const tr = this.track; if (!tr) return;
    const h = this.hit(vx, vy, touch);
    if (!h) return;
    tr.notes = tr.notes.filter((n) => n.id !== h.note.id);
    this.sel.delete(h.note.id);
    this.app.store.live(); this.app.invalidate();
  }

  autoScroll(vx, vy) {
    const vp = this.vp, edge = 28, spd = 10;
    let dx = 0, dy = 0;
    if (vx > vp.w - edge) dx = -spd; else if (vx < edge && vp.x0 > 0) dx = spd;
    if (vy > vp.h - edge) dy = -spd; else if (vy < edge) dy = spd;
    if (dx || dy) vp.panBy(dx, dy);
  }

  setMarker(t, redraw = true) { this.marker = clamp(this.step ? snapRound(t, this.step) : t, 0, this.tMax); if (redraw) this.app.invalidate(); this.app.refreshUi(); }
  keyPreview(p) {
    const m = clamp(Math.round(this.vp.yToPitch(p.y - RULER)), MIDI_MIN, MIDI_MAX);
    if (this.drag && this.drag.m === m) return;
    if (this.drag) this.drag.m = m;
    this.keyPreviewMidi(m);
  }
  keyPreviewMidi(m) { const tr = this.track; if (tr && this.app.engine) { this.app.engine.syncTracks(this.project.tracks); this.app.engine.preview(tr, m, 0.3); } }

  // ---- actions (toolbar / keyboard) ----
  selectAll() { const tr = this.track; if (tr) { this.sel = new Set(tr.notes.map((n) => n.id)); this.app.refreshUi(); this.app.invalidate(); } }
  deleteSelected() {
    const tr = this.track; if (!tr || !this.sel.size) return;
    const ids = new Set(this.sel);
    this.app.store.transact('Видалити', () => { tr.notes = tr.notes.filter((n) => !ids.has(n.id)); });
    this.sel = new Set(); this.app.refreshUi(); this.app.invalidate();
  }
  copy() { const c = copyNotes(this.notesOf()); if (c) { this.clip = c; this.app.toast(`Скопійовано: ${c.items.length}`); } this.app.refreshUi(); }
  cut() { this.copy(); this.deleteSelected(); }
  paste() {
    const tr = this.track; if (!tr || !this.clip) { this.app.toast('Спочатку скопіюйте ноти'); return; }
    let made = [];
    this.app.store.transact('Вставити', (p) => { made = pasteNotes(tr, this.clip, this.marker, p); resolveOverlaps(tr, made.map((n) => n.id)); });
    this.sel = new Set(made.map((n) => n.id));
    this.marker = clamp(this.marker + this.clip.span, 0, this.tMax);
    this.app.refreshUi(); this.app.invalidate();
  }
  duplicate() {
    const tr = this.track; const src = this.notesOf(); if (!tr || !src.length) return;
    const c = copyNotes(src); const at = Math.min(...src.map((n) => n.t)) + c.span;
    let made = [];
    this.app.store.transact('Дублювати', (p) => { made = pasteNotes(tr, c, at, p); resolveOverlaps(tr, made.map((n) => n.id)); });
    this.sel = new Set(made.map((n) => n.id)); this.app.refreshUi(); this.app.invalidate();
  }
  nudge(dt, dm) {
    const tr = this.track; const src = this.notesOf(); if (!tr || !src.length) return false;
    for (const n of src) { if (n.t + dt < -1e-9 || n.t + n.d + dt > this.tMax + 1e-9 || n.m + dm < MIDI_MIN || n.m + dm > MIDI_MAX) return true; }
    this.app.store.transact('Зсув', () => { for (const n of src) { n.t += dt; n.m += dm; } resolveOverlaps(tr, this.sel); });
    this.app.invalidate(); return true;
  }
  setVelocity(v) { const src = this.notesOf(); if (!src.length) return; this.app.store.transact('Гучність нот', () => { for (const n of src) n.v = clamp(v, 0.05, 1); }); this.app.invalidate(); }
  quantize() {
    const src = this.notesOf(); const step = this.step || 0.25; const tr = this.track;
    if (!src.length) return;
    this.app.store.transact('Квантування', () => { for (const n of src) { n.t = clamp(snapRound(n.t, step), 0, this.tMax - n.d); } resolveOverlaps(tr, this.sel); });
    this.app.invalidate();
  }
  reverse() {
    const src = this.notesOf(); if (!src.length) return;
    const t0 = Math.min(...src.map((n) => n.t)), t1 = Math.max(...src.map((n) => n.t + n.d));
    this.app.store.transact('Реверс', () => reverseNotes(src, t0, t1)); this.app.invalidate();
  }
  mirror() {
    const src = this.notesOf(); if (!src.length) return;
    const axis = (Math.min(...src.map((n) => n.m)) + Math.max(...src.map((n) => n.m))) / 2;
    this.app.store.transact('Віддзеркалення', () => mirrorNotes(src, axis)); this.app.invalidate();
  }

  zoomH(f) { this.vp.zoomX(f, this.vp.w / 2); this.app.invalidate(); }
  zoomV(f) { this.vp.zoomY(f, this.vp.h / 2); this.app.invalidate(); }
  octave(dir) { this.vp.pTop += dir * 12; this.vp.clamp(); this.app.invalidate(); }
  fit() { this.vp.fitX(); this.vp.centerPitch(66); this.app.invalidate(); }

  key(e) {
    const meta = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    const step = this.step || 0.25;
    if (meta && k === 'a') { this.selectAll(); return true; }
    if (meta && k === 'c') { this.copy(); return true; }
    if (meta && k === 'x') { this.cut(); return true; }
    if (meta && k === 'v') { this.paste(); return true; }
    if (meta && k === 'd') { this.duplicate(); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (this.sel.size) { this.deleteSelected(); return true; } return false; }
    if (e.key === 'Escape') { this.sel = new Set(); this.app.refreshUi(); this.app.invalidate(); return true; }
    if (!this.sel.size) return false;
    if (e.key === 'ArrowLeft') return this.nudge(e.shiftKey ? -4 : -step, 0);
    if (e.key === 'ArrowRight') return this.nudge(e.shiftKey ? 4 : step, 0);
    if (e.key === 'ArrowUp') return this.nudge(0, e.shiftKey ? 12 : 1);
    if (e.key === 'ArrowDown') return this.nudge(0, e.shiftKey ? -12 : -1);
    return false;
  }

  // ---- drawing ----
  draw() {
    const { g, vp, app } = this;
    const W = vp.w + KEYW, H = vp.h + RULER, project = this.project, tr = this.track;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = COLORS.bg; g.fillRect(0, 0, W, H);
    g.save(); g.translate(KEYW, RULER); g.beginPath(); g.rect(0, 0, vp.w, vp.h); g.clip();
    const hiM = Math.ceil(vp.yToPitch(0)), loM = Math.floor(vp.yToPitch(vp.h));
    const { root, type } = project.scale;
    for (let m = loM; m <= hiM; m++) {
      if (m < MIDI_MIN || m > MIDI_MAX) continue;
      const y1 = vp.pitchToY(m + 0.5), y2 = vp.pitchToY(m - 0.5);
      const black = BLACK[((m % 12) + 12) % 12], sc = app.prefs.showScale && inScale(m, root, type);
      g.fillStyle = sc ? (black ? '#17304a' : '#1a3753') : black ? '#0c151f' : '#101c29';
      g.fillRect(0, y1, vp.w, y2 - y1);
      g.strokeStyle = m % 12 === 0 ? COLORS.bar : COLORS.grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, Math.round(y2) + 0.5); g.lineTo(vp.w, Math.round(y2) + 0.5); g.stroke();
    }
    // end of composition shading
    const endX = vp.timeToX(this.tMax);
    drawTimeGrid(g, vp, this.step, vp.h, false);
    if (endX < vp.w) { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(endX, 0, vp.w - endX, vp.h); }
    // ghosts: other tracks' notes and lines
    for (const t of project.tracks) {
      if (isDrums(t) || (tr && t.id === tr.id)) continue;
      g.fillStyle = trackColor(t); g.globalAlpha = 0.2;
      for (const n of t.notes) { const r = this.rect(n); if (r.x2 < 0 || r.x1 > vp.w) continue; g.fillRect(r.x1, r.y1 + 3, Math.max(2, r.x2 - r.x1), Math.max(2, r.y2 - r.y1 - 6)); }
      g.globalAlpha = 1;
    }
    for (const t of project.tracks) for (const l of t.lines || []) drawPolyline(g, vp, l.pts, 2, trackColor(t), t.id === (tr && tr.id) ? 0.4 : 0.22);
    // notes of the active track
    if (tr) {
      const col = trackColor(tr);
      for (const n of tr.notes) {
        const r = this.rect(n);
        if (r.x2 < 0 || r.x1 > vp.w || r.y2 < 0 || r.y1 > vp.h) continue;
        const w = Math.max(3, r.x2 - r.x1), h = r.y2 - r.y1;
        const sel = this.sel.has(n.id);
        g.globalAlpha = 0.5 + 0.5 * n.v; g.fillStyle = col; g.fillRect(r.x1, r.y1 + 1, w, h - 2);
        g.globalAlpha = 1;
        g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(r.x1 + w - Math.min(5, w * 0.35), r.y1 + 1, Math.min(5, w * 0.35), h - 2); // resize handle
        if (sel) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(r.x1 + 1, r.y1 + 2, w - 2, h - 4); }
        else { g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.strokeRect(r.x1 + 0.5, r.y1 + 1.5, w - 1, h - 3); }
        if (w > 30 && h > 14) { g.fillStyle = 'rgba(8,16,24,.85)'; g.font = '600 10px -apple-system, system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(noteName(n.m), r.x1 + 5, (r.y1 + r.y2) / 2); }
      }
    }
    const d = this.drag;
    if (d && d.kind === 'marquee' && d.moved) {
      g.fillStyle = 'rgba(120,190,255,.15)'; g.strokeStyle = 'rgba(160,210,255,.8)'; g.lineWidth = 1;
      const x = Math.min(d.x0, d.x), y = Math.min(d.y0, d.y), w = Math.abs(d.x - d.x0), h = Math.abs(d.y - d.y0);
      g.fillRect(x, y, w, h); g.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    // insert marker
    const mx = Math.round(vp.timeToX(this.marker)) + 0.5;
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(mx, 0); g.lineTo(mx, vp.h); g.stroke(); g.setLineDash([]);
    if (app.transport && app.transport.playing) {
      const x = Math.round(vp.timeToX(app.transport.position())) + 0.5;
      g.strokeStyle = COLORS.play; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, vp.h); g.stroke();
    }
    // scroll indicators
    g.fillStyle = 'rgba(255,255,255,.18)';
    if (vp.tVisible < vp.tMax - 1e-6) g.fillRect((vp.x0 / vp.tMax) * vp.w, vp.h - 4, (vp.tVisible / vp.tMax) * vp.w, 3);
    const span = vp.pHi - vp.pLo;
    if (vp.pVisible < span - 1e-6) g.fillRect(vp.w - 4, ((vp.pHi - vp.pTop) / span) * vp.h, 3, (vp.pVisible / span) * vp.h);
    g.restore();

    // ruler
    g.fillStyle = '#0f1b28'; g.fillRect(KEYW, 0, vp.w, RULER);
    g.save(); g.translate(KEYW, 0); g.beginPath(); g.rect(0, 0, vp.w, RULER); g.clip();
    g.font = '10px -apple-system, system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
    const t0 = Math.floor(vp.x0), t1 = vp.x0 + vp.tVisible;
    for (let t = t0; t <= t1 + 1; t++) {
      const x = Math.round(vp.timeToX(t)) + 0.5, bar = t % 4 === 0;
      if (!bar && vp.ppb < 18) continue;
      g.strokeStyle = bar ? COLORS.bar : COLORS.beat; g.beginPath(); g.moveTo(x, bar ? 4 : RULER - 8); g.lineTo(x, RULER); g.stroke();
      if (bar) { g.fillStyle = COLORS.textBright; g.fillText(String(t / 4 + 1), x + 4, 9); }
      else if (vp.ppb >= 44) { g.fillStyle = COLORS.text; g.fillText(`${Math.floor(t / 4) + 1}.${(t % 4) + 1}`, x + 3, 14); }
    }
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(mx - 5, RULER - 9); g.lineTo(mx + 5, RULER - 9); g.lineTo(mx, RULER - 1); g.fill();
    g.restore();
    g.strokeStyle = COLORS.bar; g.beginPath(); g.moveTo(KEYW, RULER + 0.5); g.lineTo(W, RULER + 0.5); g.stroke();

    // piano keys
    g.save(); g.translate(0, RULER); g.beginPath(); g.rect(0, 0, KEYW, vp.h); g.clip();
    for (let m = loM; m <= hiM; m++) {
      if (m < MIDI_MIN || m > MIDI_MAX) continue;
      const y1 = vp.pitchToY(m + 0.5), y2 = vp.pitchToY(m - 0.5), black = BLACK[((m % 12) + 12) % 12];
      const sc = app.prefs.showScale && inScale(m, root, type);
      g.fillStyle = black ? '#1a2634' : '#c9d6e2'; g.fillRect(0, y1, KEYW - 1, y2 - y1 - 1);
      if (sc) { g.fillStyle = 'rgba(80,170,255,.35)'; g.fillRect(0, y1, KEYW - 1, y2 - y1 - 1); }
      if (m % 12 === 0 || vp.ppm >= 20 || (!black && vp.ppm >= 16)) {
        g.fillStyle = black ? '#9db3c6' : '#16222f'; g.font = '600 10px -apple-system, system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(noteName(m), 6, (y1 + y2) / 2);
      }
    }
    g.restore();
    g.fillStyle = '#0f1b28'; g.fillRect(0, 0, KEYW, RULER);
    g.fillStyle = COLORS.text; g.font = '10px -apple-system, system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(this.step ? `1/${4 / this.step}` : 'free', 8, RULER / 2);
  }
}

export { midiToFreq };
