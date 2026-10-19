// Transport + lookahead scheduler. Timing comes from the audio clock only, never from rAF.
import { lineFreqs } from './curve.js';
import { totalBeats, isDrums } from './model.js';

export const LOOKAHEAD = 0.18; // seconds
export const TICK_MS = 25;
const STEP = 0.25; // one drum step = 1/16 note = 0.25 beat

const sigNote = (tr, n) => `${tr.id}|${n.t}|${n.d}|${n.m}|${n.v}`;
const sigLine = (tr, l) => `${tr.id}|${l.mode}|${l.amount}|${l.snap}|${l.pts.length}|${l.pts[0] ? l.pts[0].t + ',' + l.pts[0].p + ',' + l.pts[l.pts.length - 1].t : ''}`;

// Scheduling core shared by realtime playback and offline rendering.
export class Scheduler {
  constructor(engine, getProject, timeOf) {
    this.engine = engine;
    this.getProject = getProject;
    this.timeOf = timeOf; // (absBeat) => audio time
    this.registry = new Map(); // item id -> Set(voice)
    this.known = new Map(); // item id -> signature
  }
  _register(id, voice) {
    if (!voice) return;
    let set = this.registry.get(id);
    if (!set) { set = new Set(); this.registry.set(id, set); }
    set.add(voice);
    voice.onEnd = () => { set.delete(voice); if (!set.size) this.registry.delete(id); };
  }
  killItem(id, when) {
    const set = this.registry.get(id);
    if (!set) return;
    for (const v of [...set]) v.kill(when);
    this.registry.delete(id);
  }
  killAll(when) { for (const id of [...this.registry.keys()]) this.killItem(id, when); this.known.clear(); }

  // Play (a copy of) one item. `nowAbs` enables joining an item already in progress.
  playItem(track, kind, item, base, nowAbs) {
    const p = this.getProject();
    const e = this.engine, ctx = e.ctx;
    let a0, a1;
    if (kind === 'note') { a0 = base + item.t; a1 = a0 + item.d; }
    else { if (!item.pts || item.pts.length < 2) return; a0 = base + item.pts[0].t; a1 = base + item.pts[item.pts.length - 1].t; }
    const s = Math.max(a0, nowAbs);
    if (a1 - s < 0.004) return;
    const t0 = Math.max(this.timeOf(s), ctx.currentTime + 0.003);
    const t1 = Math.max(this.timeOf(a1), t0 + 0.01);
    let v;
    if (kind === 'note') v = e.playNote(track, { t0, t1, midi: item.m, vel: item.v });
    else {
      const { values } = lineFreqs(item.pts, s - base, a1 - base, p.bpm);
      v = e.playCurve(track, { t0, t1, values, vel: 0.85 });
    }
    this._register(item.id, v);
    this.known.set(item.id, kind === 'note' ? sigNote(track, item) : sigLine(track, item));
  }

  // Schedule everything that starts in local beats [l0, l1) of loop copy at `base`.
  span(l0, l1, base, nowAbs) {
    const p = this.getProject();
    for (const tr of p.tracks) {
      if (isDrums(tr)) {
        if (!this.engine.isAudible(tr.id)) continue;
        const first = Math.ceil(l0 / STEP - 1e-9), last = Math.ceil(l1 / STEP - 1e-9);
        for (let s = first; s < last; s++) {
          const abs = base + s * STEP;
          const when = Math.max(this.timeOf(abs), this.engine.ctx.currentTime + 0.002);
          for (const lane of p.drums.lanes) {
            const v = lane.steps[s % lane.len];
            if (v > 0) this.engine.playDrum(lane.id, when, v);
          }
        }
        continue;
      }
      if (!this.engine.isAudible(tr.id)) continue;
      for (const n of tr.notes) if (n.t >= l0 - 1e-9 && n.t < l1 - 1e-9) this.playItem(tr, 'note', n, base, nowAbs);
      for (const l of tr.lines) if (l.pts && l.pts.length > 1 && l.pts[0].t >= l0 - 1e-9 && l.pts[0].t < l1 - 1e-9) this.playItem(tr, 'line', l, base, nowAbs);
    }
  }
}

export class Transport {
  constructor(engine, store) {
    this.engine = engine;
    this.store = store;
    this.playing = false;
    this.loop = true;
    this.anchorTime = 0;
    this.anchorBeat = 0;
    this.scheduledUntil = 0;
    this.timer = null;
    this.sched = new Scheduler(engine, () => store.project, (abs) => this.timeOf(abs));
    this.onstop = null;
    store.on('commit', () => this.refresh());
    engine.ctx.addEventListener('statechange', () => { if (this.playing && engine.ctx.state !== 'running') this.stop(); });
  }
  get project() { return this.store.project; }
  get total() { return totalBeats(this.project); }
  timeOf(abs) { return this.anchorTime + ((abs - this.anchorBeat) * 60) / this.project.bpm; }
  absBeat(time) { return this.anchorBeat + ((time - this.anchorTime) * this.project.bpm) / 60; }

  // Beat position of the playhead (compensated for output latency), looped.
  position() {
    if (!this.playing) return 0;
    const c = this.engine.ctx;
    const lat = (c.baseLatency || 0) + (c.outputLatency || 0);
    const abs = this.absBeat(c.currentTime - lat);
    if (abs < 0) return 0;
    const tot = this.total;
    if (!this.loop) return Math.min(abs, tot);
    return abs % tot;
  }

  async start() {
    if (this.playing) return;
    await this.engine.resume();
    const c = this.engine.ctx;
    this.engine.syncTracks(this.project.tracks);
    this.engine.setMaster(this.project.master, this.project.bpm);
    this.anchorTime = c.currentTime + 0.06;
    this.anchorBeat = 0;
    this.scheduledUntil = 0;
    this.sched.killAll(c.currentTime);
    this.playing = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer); this.timer = null;
    this.sched.killAll(this.engine.ctx.currentTime);
    this.engine.killAll();
    if (this.onstop) this.onstop();
  }

  tick() {
    if (!this.playing) return;
    const c = this.engine.ctx, tot = this.total;
    const nowAbs = this.absBeat(c.currentTime);
    const target = this.absBeat(c.currentTime + LOOKAHEAD);
    let from = this.scheduledUntil;
    while (from < target) {
      const k = Math.floor(from / tot);
      if (!this.loop && k > 0) break;
      const segEnd = Math.min(target, (k + 1) * tot);
      this.sched.span(from - k * tot, segEnd - k * tot, k * tot, nowAbs);
      from = segEnd;
    }
    this.scheduledUntil = Math.max(this.scheduledUntil, from);
    if (!this.loop && nowAbs > tot + 2.5) this.stop();
  }

  // Re-anchor tempo/length changes so playback stays continuous.
  resync() {
    if (!this.playing) return;
    const c = this.engine.ctx;
    const nowAbs = Math.max(0, this.absBeat(c.currentTime));
    this.sched.killAll(c.currentTime);
    this.anchorBeat = this.loop ? nowAbs % this.total : Math.min(nowAbs, this.total);
    this.anchorTime = c.currentTime;
    this.scheduledUntil = this.anchorBeat;
    this.joinInProgress();
    this.tick();
  }

  joinInProgress() {
    const p = this.project, tot = this.total, now = this.anchorBeat, base = 0;
    for (const tr of p.tracks) {
      if (isDrums(tr) || !this.engine.isAudible(tr.id)) continue;
      for (const n of tr.notes) if (n.t < now && n.t + n.d > now) this.sched.playItem(tr, 'note', n, base, now);
      for (const l of tr.lines) if (l.pts && l.pts.length > 1 && l.pts[0].t < now && l.pts[l.pts.length - 1].t > now) this.sched.playItem(tr, 'line', l, base, now);
    }
    return tot;
  }

  // Called after every committed edit: stop voices of removed/changed items and
  // (re)start those that are sounding now or inside the already-scheduled window.
  refresh() {
    if (!this.playing) return;
    const c = this.engine.ctx, p = this.project, tot = this.total;
    this.engine.syncTracks(p.tracks);
    this.engine.setMaster(p.master, p.bpm);
    const nowAbs = Math.max(0, this.absBeat(c.currentTime));
    const until = this.scheduledUntil;
    const kNow = Math.floor(nowAbs / tot);
    const seen = new Set();
    const check = (tr, kind, item) => {
      seen.add(item.id);
      const sig = kind === 'note' ? sigNote(tr, item) : sigLine(tr, item);
      if (this.sched.known.get(item.id) === sig) return;
      this.sched.killItem(item.id, c.currentTime);
      this.sched.known.set(item.id, sig);
      if (!this.engine.isAudible(tr.id)) return;
      for (const k of [kNow, kNow + 1]) {
        if (!this.loop && k > 0) break;
        const base = k * tot;
        const a0 = base + (kind === 'note' ? item.t : (item.pts[0] ? item.pts[0].t : 0));
        const a1 = kind === 'note' ? a0 + item.d : base + (item.pts[item.pts.length - 1] ? item.pts[item.pts.length - 1].t : 0);
        if (kind === 'line' && (!item.pts || item.pts.length < 2)) continue;
        if (a1 > nowAbs + 0.01 && a0 < until) this.sched.playItem(tr, kind, item, base, nowAbs);
      }
    };
    for (const tr of p.tracks) {
      if (isDrums(tr)) continue;
      for (const n of tr.notes) check(tr, 'note', n);
      for (const l of tr.lines) check(tr, 'line', l);
    }
    for (const id of [...this.sched.known.keys()]) if (!seen.has(id)) { this.sched.killItem(id, c.currentTime); this.sched.known.delete(id); }
  }
}
