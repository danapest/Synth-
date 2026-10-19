// Drum sequencer: six lanes, per-lane loop length (polymeter), 3 velocity levels. DOM based.
import { DRUM_LANES, DRUM_PRESETS } from './presets.js';

const LEVELS = [0, 1, 0.5]; // tap cycles: off -> accent -> ghost -> off

export class DrumSeq {
  constructor(app, root) {
    this.app = app; this.root = root; this.rows = new Map(); this.active = null;
    this.build();
  }
  get project() { return this.app.store.project; }
  lane(id) { return this.project.drums.lanes.find((l) => l.id === id); }

  build() {
    const r = this.root; r.innerHTML = '';
    const head = el('div', 'drum-head');
    const preset = el('select'); preset.setAttribute('aria-label', 'Пресет ритму');
    preset.append(new Option('Пресет…', ''), ...Object.keys(DRUM_PRESETS).map((k) => new Option(k, k)));
    preset.onchange = () => { if (preset.value) this.applyPreset(preset.value); preset.value = ''; };
    const clear = btn('Очистити', () => this.mutate('Очистити ритм', (d) => d.lanes.forEach((l) => l.steps.fill(0))));
    const chaos = btn('Мутація', () => this.mutate('Мутація ритму', (d) => d.lanes.forEach((l) => { for (let i = 0; i < l.len; i++) if (Math.random() < 0.12) l.steps[i] = l.steps[i] ? 0 : LEVELS[1 + Math.floor(Math.random() * 2)]; })));
    head.append(el('span', 'hint', 'Крок = 1/16. Довжина кожної доріжки своя — це дає поліметр.'), preset, clear, chaos);
    r.append(head);
    this.grid = el('div', 'drum-grid');
    r.append(this.grid);
    for (const def of DRUM_LANES) {
      const row = el('div', 'drum-row');
      const name = btn(def.name, () => { this.app.audio(); this.app.engine.syncTracks(this.project.tracks); this.app.engine.playDrum(def.id, this.app.engine.ctx.currentTime + 0.01, 1); });
      name.className = 'drum-name';
      const len = el('div', 'drum-len');
      const minus = btn('−', () => this.setLen(def.id, -1)), plus = btn('+', () => this.setLen(def.id, 1));
      const val = el('b'); len.append(minus, val, plus);
      const steps = el('div', 'drum-steps');
      steps.style.touchAction = 'none';
      this.bindSteps(steps, def.id);
      row.append(name, len, steps);
      this.grid.append(row);
      this.rows.set(def.id, { steps, val, cells: [] });
    }
    this.refresh();
  }

  bindSteps(steps, id) {
    let paint = null;
    const idx = (e) => { const b = steps.getBoundingClientRect(); const l = this.lane(id); return Math.max(0, Math.min(l.len - 1, Math.floor(((e.clientX - b.left) / b.width) * l.len))); };
    steps.addEventListener('pointerdown', (e) => {
      e.preventDefault(); steps.setPointerCapture(e.pointerId);
      this.app.audio();
      const l = this.lane(id), i = idx(e);
      const next = LEVELS[(LEVELS.indexOf(l.steps[i]) + 1) % LEVELS.length];
      this.app.store.begin(); paint = next; l.steps[i] = next; this.lastI = i;
      if (next) { this.app.engine.syncTracks(this.project.tracks); this.app.engine.playDrum(id, this.app.engine.ctx.currentTime + 0.01, next); }
      this.refreshRow(id); this.app.store.live();
    });
    steps.addEventListener('pointermove', (e) => {
      if (paint === null) return;
      const l = this.lane(id), i = idx(e);
      if (i === this.lastI) return;
      this.lastI = i; l.steps[i] = paint; this.refreshRow(id); this.app.store.live();
    });
    const end = (cancel) => (e) => {
      if (paint === null) return; paint = null;
      if (cancel) this.app.store.cancel(); else this.app.store.commit('Ритм');
      this.refreshRow(id);
    };
    steps.addEventListener('pointerup', end(false));
    steps.addEventListener('pointercancel', end(true));
  }

  mutate(label, fn) { this.app.store.transact(label, (p) => fn(p.drums)); this.refresh(); }
  applyPreset(name) {
    const pat = DRUM_PRESETS[name];
    this.mutate('Пресет ритму', (d) => { for (const l of d.lanes) { const s = pat[l.id] || ''; l.len = 16; l.steps = [...s.padEnd(16, '0')].map((c) => (c === '1' ? 1 : 0)); } });
  }
  setLen(id, dir) {
    this.app.store.transact('Довжина доріжки', (p) => {
      const l = p.drums.lanes.find((x) => x.id === id);
      const len = Math.max(1, Math.min(32, l.len + dir));
      const steps = l.steps.slice(0, len); while (steps.length < len) steps.push(0);
      l.len = len; l.steps = steps;
    });
    this.refreshRow(id);
  }

  refreshRow(id) {
    const l = this.lane(id), row = this.rows.get(id);
    if (!l || !row) return;
    row.val.textContent = l.len;
    if (row.cells.length !== l.len) {
      row.steps.innerHTML = ''; row.cells = [];
      for (let i = 0; i < l.len; i++) { const c = el('div', 'step'); if (i % 4 === 0) c.classList.add('beat'); row.steps.append(c); row.cells.push(c); }
    }
    for (let i = 0; i < l.len; i++) { const v = l.steps[i]; const c = row.cells[i]; c.classList.toggle('on', v === 1); c.classList.toggle('ghost', v > 0 && v < 1); }
  }
  refresh() { for (const id of this.rows.keys()) this.refreshRow(id); }

  // playhead highlight, called every animation frame while playing
  tick(pos) {
    const step = pos === null ? -1 : Math.floor(pos * 4 + 1e-6);
    for (const [id, row] of this.rows) {
      const l = this.lane(id); if (!l) continue;
      const i = step < 0 ? -1 : step % l.len;
      if (row.active === i) continue;
      if (row.active !== undefined && row.cells[row.active]) row.cells[row.active].classList.remove('play');
      row.active = i;
      if (i >= 0 && row.cells[i]) row.cells[i].classList.add('play');
    }
  }
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
function btn(text, fn) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = fn; return b; }
