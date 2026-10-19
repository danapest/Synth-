// Composition root: wires store, audio, transport, editors and the UI shell together.
import { SNAPS, clamp, BEATS_PER_BAR } from './coords.js';
import { createContext, Engine } from './audio.js';
import { Transport } from './transport.js';
import { Store } from './store.js';
import { createProject, createTrack, sanitizeProject, demoProject, isDrums, synthTracks, trackColor, computeAllLines, serialize, LIMITS, uid } from './model.js';
import { INSTRUMENTS, WAVES } from './presets.js';
import { SCALES } from './scales.js';
import { FreeDraw } from './freedraw.js';
import { PianoRoll } from './pianoroll.js';
import { DrumSeq } from './drumseq.js';
import { MODES } from './curve.js';
import { harmonize, mutateNotes, bassFromTrack } from './ops.js';
import { saveProject, loadLastProject, listProjects, loadProject, deleteProject, loadPrefs, savePrefs } from './storage.js';
import { downloadJson, downloadMidi, downloadWav } from './export.js';

const $ = (id) => document.getElementById(id);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
}
const VIEWS = [['draw', 'Малювати'], ['notes', 'Ноти'], ['drums', 'Ритм'], ['mix', 'Мікс']];
const NOTE_LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

class App {
  constructor() {
    this.prefs = { snap: '1/16', tool: 'draw', mode: 'natural', amount: 35, snapScale: false, showScale: true, dupMode: false, monitor: true, view: 'draw', trackId: null, loop: true, ...loadPrefs() };
    this.store = new Store(loadLastProject());
    this.engine = null; this.transport = null;
    this.dirty = true; this.saveTimer = null; this.saveFailed = false;
    this.activeTrackId = this.prefs.trackId;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.fd = new FreeDraw(this, $('cvDraw'));
    this.pr = new PianoRoll(this, $('cvNotes'));
    this.drums = new DrumSeq(this, $('drumView'));
    this.editors = { draw: this.fd, notes: this.pr };

    this.store.on('live', () => { this.syncAudio(); this.invalidate(); });
    this.store.on('commit', (e) => this.onCommit(e));
    this.buildShell();
    this.bindGlobal();
    this.observeSize();
    this.setView(this.prefs.view, true);
    this.renderTrackBar();
    this.refreshUi();
    requestAnimationFrame(() => this.frame());
    window.addEventListener('pointerdown', () => this.audio(), { once: true, capture: true });
  }

  // ---------- state helpers ----------
  get project() { return this.store.project; }
  activeTrack() {
    const p = this.project;
    let t = p.tracks.find((x) => x.id === this.activeTrackId && !isDrums(x));
    if (!t) { t = synthTracks(p)[0]; this.activeTrackId = t ? t.id : null; }
    return t || null;
  }
  setActiveTrack(id) { if (this.activeTrackId !== id) { this.activeTrackId = id; this.prefs.trackId = id; this.persistPrefs(); } this.renderTrackBar(); this.pr.onProjectChange(); this.invalidate(); }
  persistPrefs() { savePrefs(this.prefs); }
  invalidate() { this.dirty = true; }
  toast(msg, ms = 2400) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('show'), ms); }

  audio() {
    if (!this.engine) {
      const ctx = createContext();
      this.engine = new Engine(ctx);
      this.transport = new Transport(this.engine, this.store);
      this.transport.loop = this.prefs.loop;
      this.transport.onstop = () => this.refreshUi();
    }
    this.syncAudio();
    if (this.engine.ctx.state !== 'running') this.engine.ctx.resume().catch(() => {});
    return this.engine;
  }
  syncAudio() { if (this.engine) { this.engine.syncTracks(this.project.tracks); this.engine.setMaster(this.project.master, this.project.bpm); } }

  async togglePlay() {
    this.audio();
    if (this.transport.playing) { this.transport.stop(); this.refreshUi(); return; }
    try { await this.transport.start(); } catch (e) { this.toast('Не вдалося запустити звук: ' + e.message); }
    this.refreshUi();
  }

  onCommit(evt) {
    this.syncAudio();
    for (const ed of Object.values(this.editors)) ed.onProjectChange();
    this.drums.refresh();
    this.scheduleSave();
    if (this.prefs.view === 'mix') this.buildMix();
    this.renderTrackBar();
    this.refreshUi();
    this.invalidate();
    if (evt && (evt.reason === 'undo' || evt.reason === 'redo') && evt.label) this.toast((evt.reason === 'undo' ? 'Скасовано: ' : 'Повернено: ') + evt.label, 1400);
  }

  scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveNow(), 350); }
  saveNow() {
    clearTimeout(this.saveTimer);
    try { saveProject(this.project); this.saveFailed = false; $('saveState').textContent = ''; }
    catch (e) { if (!this.saveFailed) this.toast('Не вдалося зберегти: сховище недоступне або повне. Зробіть експорт JSON.', 5000); this.saveFailed = true; $('saveState').textContent = '!'; }
  }

  // ---------- project lifecycle ----------
  loadProjectObject(p) {
    if (this.transport) this.transport.stop();
    this.saveNow();
    computeAllLines(p);
    this.activeTrackId = null;
    this.store.load(p);
    this.fd.selected = null; this.pr.sel = new Set(); this.pr.marker = 0;
    this.fd.vp.setTMax(p.bars * BEATS_PER_BAR); this.fd.vp.fitX(); this.fd.vp.fitY();
    this.pr.vp.setTMax(p.bars * BEATS_PER_BAR);
    this.renderTrackBar(); this.refreshUi();
  }
  newProject() { this.loadProjectObject(createProject('Новий проєкт ' + (listProjects().length + 1))); this.closeSheet(); }
  openDemo() { const p = demoProject(); p.id = uid(); this.loadProjectObject(p); this.closeSheet(); }
  duplicateProject() { const p = JSON.parse(serialize(this.project)); p.id = uid(); p.name = (p.name + ' копія').slice(0, 60); p.created = p.updated = Date.now(); this.loadProjectObject(sanitizeProject(p)); this.closeSheet(); }
  switchProject(id) { const p = loadProject(id); if (!p) { this.toast('Не вдалося відкрити проєкт'); return; } this.loadProjectObject(p); this.closeSheet(); }
  removeProject(id) {
    if (!confirm('Видалити проєкт назавжди?')) return;
    deleteProject(id);
    if (id === this.project.id) { const rest = listProjects(); const next = rest[0] && loadProject(rest[0].id); this.loadProjectObject(next || createProject()); }
    this.openProjectSheet();
  }
  async importFile(file) {
    try {
      if (file.size > 20e6) throw new Error('Файл завеликий');
      const p = sanitizeProject(JSON.parse(await file.text()));
      p.id = uid(); p.updated = Date.now();
      this.loadProjectObject(p); this.closeSheet(); this.toast('Імпортовано: ' + p.name);
    } catch (e) { this.toast('Помилка імпорту: ' + (e.message || e), 5000); }
  }

  // ---------- shell ----------
  buildShell() {
    const tabs = $('views');
    for (const [id, label] of VIEWS) tabs.append(h('button', { 'data-view': id, onclick: () => this.setView(id), role: 'tab' }, label));
    $('btnPlay').onclick = () => this.togglePlay();
    $('btnUndo').onclick = () => { this.store.undo(); };
    $('btnRedo').onclick = () => { this.store.redo(); };
    $('btnBpm').onclick = () => this.openTimeSheet();
    $('btnMenu').onclick = () => this.openProjectSheet();
    $('projName').onclick = () => this.openProjectSheet();
    $('sheetBackdrop').onclick = () => this.closeSheet();
    $('sheetClose').onclick = () => this.closeSheet();
    $('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importFile(f); };
  }

  setView(v, silent) {
    if (!VIEWS.some(([id]) => id === v)) v = 'draw';
    this.prefs.view = v; this.persistPrefs();
    for (const s of document.querySelectorAll('#stage > section')) s.hidden = s.dataset.view !== v;
    for (const b of $('views').children) { const on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); }
    $('trackbar').hidden = v === 'drums' || v === 'mix';
    if (v === 'mix') this.buildMix();
    this.buildToolbar();
    this.measure();
    this.invalidate();
    if (!silent) this.refreshUi();
  }

  observeSize() {
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe($('stage'));
    window.addEventListener('orientationchange', () => setTimeout(() => this.measure(), 200));
  }
  measure() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [id, cv, ed] of [['draw', $('cvDraw'), this.fd], ['notes', $('cvNotes'), this.pr]]) {
      const sec = cv.parentElement; if (sec.hidden) continue;
      const w = Math.max(1, Math.round(sec.clientWidth)), hgt = Math.max(1, Math.round(sec.clientHeight));
      cv.width = Math.round(w * this.dpr); cv.height = Math.round(hgt * this.dpr);
      ed.dpr = this.dpr; ed.resize(w, hgt);
    }
    this.invalidate();
  }

  frame() {
    const playing = this.transport && this.transport.playing;
    if (this.dirty || playing) {
      this.dirty = false;
      const v = this.prefs.view;
      if (v === 'draw' || v === 'notes') this.editors[v].draw();
      if (v === 'drums') this.drums.tick(playing ? this.transport.position() : null);
      if (v === 'mix') this.drawSpectrum();
    } else if (this.prefs.view === 'mix' && this.engine) this.drawSpectrum();
    requestAnimationFrame(() => this.frame());
  }

  // ---------- track bar ----------
  renderTrackBar() {
    const bar = $('trackbar'); bar.innerHTML = '';
    const active = this.activeTrack();
    for (const t of synthTracks(this.project)) {
      const chip = h('button', { class: 'chip-track' + (active && t.id === active.id ? ' active' : '') + (t.mute ? ' muted' : ''), style: `--c:${trackColor(t)}`, onclick: () => { if (active && active.id === t.id) this.openTrackSheet(t.id); else this.setActiveTrack(t.id); } },
        h('i'), t.name);
      bar.append(chip);
    }
    if (synthTracks(this.project).length < LIMITS.tracks - 1) bar.append(h('button', { class: 'chip-track add', 'aria-label': 'Додати доріжку', onclick: () => this.openAddTrackSheet() }, '+'));
    bar.append(h('button', { class: 'chip-track gear', 'aria-label': 'Налаштування доріжки', onclick: () => active && this.openTrackSheet(active.id) }, '⚙'));
  }

  // ---------- toolbar ----------
  buildToolbar() {
    const tb = $('toolbar'); tb.innerHTML = ''; this.toolbarState = [];
    const v = this.prefs.view;
    const btn = (label, onclick, opt = {}) => {
      const b = h('button', { type: 'button', class: 'tb' + (opt.wide ? ' wide' : ''), title: opt.title || label, 'aria-label': opt.title || label, onclick }, label);
      if (opt.active) this.toolbarState.push([b, opt.active]);
      tb.append(b); return b;
    };
    const sep = () => tb.append(h('span', { class: 'sep' }));
    const tools = () => {
      btn('✎ Малювати', () => { this.prefs.tool = 'draw'; this.persistPrefs(); this.refreshUi(); }, { active: () => this.prefs.tool === 'draw', wide: true });
      btn('⬚ Вибір', () => { this.prefs.tool = 'select'; this.persistPrefs(); this.refreshUi(); }, { active: () => this.prefs.tool === 'select', wide: true });
      btn('⌫ Гумка', () => { this.prefs.tool = 'erase'; this.persistPrefs(); this.refreshUi(); }, { active: () => this.prefs.tool === 'erase', wide: true });
    };
    if (v === 'draw') {
      tools(); sep();
      const mode = h('select', { 'aria-label': 'Режим лінії', onchange: (e) => { this.prefs.mode = e.target.value; this.persistPrefs(); this.fd.applyStyleToSelected(); } },
        MODES.map((m) => h('option', { value: m }, { smooth: 'Smooth', natural: 'Natural', sharp: 'Sharp / Step' }[m])));
      mode.value = this.prefs.mode; tb.append(mode);
      const amt = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Інтенсивність', title: 'Інтенсивність згладжування', oninput: (e) => { this.prefs.amount = +e.target.value; }, onchange: () => { this.persistPrefs(); this.fd.applyStyleToSelected(); } });
      amt.value = this.prefs.amount; tb.append(amt);
      btn('♪ Лад', () => { this.prefs.snapScale = !this.prefs.snapScale; this.persistPrefs(); this.fd.applyStyleToSelected(); this.refreshUi(); }, { active: () => this.prefs.snapScale, title: 'Прив’язка до нот ладу' });
      sep();
      btn('Лінія…', () => this.openLineSheet(), { wide: true });
      btn('⤢', () => { this.fd.vp.fitX(); this.fd.vp.fitY(); this.invalidate(); }, { title: 'Показати все' });
    } else if (v === 'notes') {
      tools(); sep();
      const snap = h('select', { 'aria-label': 'Сітка', onchange: (e) => { this.prefs.snap = e.target.value; this.persistPrefs(); this.invalidate(); } }, SNAPS.map((s) => h('option', { value: s.id }, s.id === 'off' ? 'Snap: off' : 'Snap ' + s.label)));
      snap.value = this.prefs.snap; tb.append(snap); sep();
      btn('↔−', () => this.pr.zoomH(0.7), { title: 'Зменшити по горизонталі' }); btn('↔+', () => this.pr.zoomH(1.4), { title: 'Збільшити по горизонталі' });
      btn('↕−', () => this.pr.zoomV(0.8), { title: 'Зменшити по вертикалі' }); btn('↕+', () => this.pr.zoomV(1.25), { title: 'Збільшити по вертикалі' });
      btn('Окт ▲', () => this.pr.octave(1)); btn('Окт ▼', () => this.pr.octave(-1)); btn('⤢', () => this.pr.fit(), { title: 'Показати все' });
      sep();
      btn('Копія', () => this.pr.copy(), { title: 'Копіювати' }); btn('Вставити', () => this.pr.paste(), { wide: true }); btn('Дубль', () => this.pr.duplicate(), { title: 'Дублювати' }); btn('Видалити', () => this.pr.deleteSelected(), { wide: true });
      sep();
      btn('♪ Лад', () => { this.prefs.snapScale = !this.prefs.snapScale; this.persistPrefs(); this.refreshUi(); }, { active: () => this.prefs.snapScale, title: 'Прив’язка висоти до ладу' });
      btn('⧉ Копіювати при перетягуванні', () => { this.prefs.dupMode = !this.prefs.dupMode; this.persistPrefs(); this.refreshUi(); }, { active: () => this.prefs.dupMode });
      btn('Ноти…', () => this.openNotesSheet(), { wide: true });
    } else if (v === 'drums') {
      tb.append(h('span', { class: 'tb-hint' }, 'Торкніться кроку: акцент → тихо → вимк. Тягніть, щоб малювати.'));
    } else if (v === 'mix') {
      btn('Майстер…', () => this.openMasterSheet(), { wide: true });
    }
    this.refreshToolbar();
  }
  refreshToolbar() { for (const [b, f] of this.toolbarState || []) b.classList.toggle('active', !!f()); }

  refreshUi() {
    const p = this.project, playing = !!(this.transport && this.transport.playing);
    $('btnUndo').disabled = !this.store.canUndo; $('btnRedo').disabled = !this.store.canRedo;
    const play = $('btnPlay'); play.textContent = playing ? '■' : '▶'; play.classList.toggle('on', playing); play.setAttribute('aria-label', playing ? 'Стоп' : 'Грати');
    $('bpmVal').textContent = Math.round(p.bpm * 10) / 10;
    $('projName').textContent = p.name;
    this.refreshToolbar();
    const sel = this.pr.sel.size, mk = this.pr.marker;
    $('status').textContent = this.prefs.view === 'notes'
      ? `Вставка: такт ${Math.floor(mk / 4) + 1}, доля ${Math.floor(mk % 4) + 1}${sel ? ` · вибрано нот: ${sel}` : ''}`
      : '';
  }

  // ---------- sheets ----------
  openSheet(title, ...content) {
    $('sheetTitle').textContent = title;
    const body = $('sheetBody'); body.innerHTML = ''; body.append(...content);
    $('sheet').hidden = false; document.body.classList.add('sheet-open');
    return body;
  }
  closeSheet() { $('sheet').hidden = true; document.body.classList.remove('sheet-open'); }

  // Slider bound to a project field with live audio + a single undo entry per drag.
  slider(label, get, set, { min = 0, max = 1, step = 0.01, fmt = (v) => Math.round(v * 100) + '%', title = label } = {}) {
    const out = h('output', {}, fmt(get()));
    const input = h('input', { type: 'range', min, max, step, 'aria-label': label,
      oninput: () => { this.store.begin(); set(+input.value); out.textContent = fmt(+input.value); this.store.live(); },
      onchange: () => { this.store.commit(title); } });
    input.value = get();
    return h('label', { class: 'row' }, h('span', {}, label), input, out);
  }
  select(label, options, get, set) {
    const s = h('select', { 'aria-label': label, onchange: () => set(s.value) }, options.map(([v, t]) => h('option', { value: v }, t)));
    s.value = get(); return h('label', { class: 'row' }, h('span', {}, label), s);
  }
  toggle(label, get, set) {
    const c = h('input', { type: 'checkbox', onchange: () => set(c.checked) }); c.checked = get();
    return h('label', { class: 'row check' }, c, h('span', {}, label));
  }

  openProjectSheet() {
    this.saveNow();
    const p = this.project;
    const name = h('input', { type: 'text', value: p.name, maxlength: 60, 'aria-label': 'Назва проєкту', onchange: () => { const v = name.value.trim() || 'Без назви'; this.store.transact('Назва', (pr) => { pr.name = v.slice(0, 60); }); this.refreshUi(); } });
    const list = h('div', { class: 'plist' });
    for (const e of listProjects()) {
      list.append(h('div', { class: 'prow' + (e.id === p.id ? ' cur' : '') },
        h('button', { class: 'pname', onclick: () => this.switchProject(e.id) }, h('b', {}, e.name), h('small', {}, new Date(e.updated).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }))),
        h('button', { class: 'danger', 'aria-label': 'Видалити', onclick: () => this.removeProject(e.id) }, '🗑')));
    }
    this.openSheet('Проєкти',
      h('label', { class: 'row' }, h('span', {}, 'Назва'), name),
      h('div', { class: 'btnrow' }, h('button', { onclick: () => this.newProject() }, '＋ Новий'), h('button', { onclick: () => this.openDemo() }, 'Приклад'), h('button', { onclick: () => this.duplicateProject() }, 'Дублювати')),
      h('h3', {}, 'Мої проєкти'), list,
      h('h3', {}, 'Імпорт / експорт'),
      h('div', { class: 'btnrow' }, h('button', { onclick: () => $('fileInput').click() }, 'Імпорт JSON'), h('button', { onclick: () => { this.saveNow(); downloadJson(this.project); } }, 'Експорт JSON')),
      h('div', { class: 'btnrow' },
        h('button', { onclick: async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Рендер…'; try { await downloadWav(this.project); } catch (err) { this.toast('WAV: ' + err.message, 5000); } b.disabled = false; b.textContent = 'Експорт WAV'; } }, 'Експорт WAV'),
        h('button', { onclick: () => downloadMidi(this.project) }, 'Експорт MIDI')),
      h('p', { class: 'note' }, 'Проєкт зберігається автоматично на цьому пристрої. MIDI містить ноти та ритм; вільні лінії лише у WAV та JSON.'));
  }

  openTimeSheet() {
    const p = this.project;
    const bpmIn = h('input', { type: 'number', min: LIMITS.bpmMin, max: LIMITS.bpmMax, step: 1, inputmode: 'decimal', 'aria-label': 'BPM' });
    bpmIn.value = p.bpm;
    const setBpm = (v) => { v = clamp(Math.round(v * 10) / 10 || 120, LIMITS.bpmMin, LIMITS.bpmMax); this.store.transact('BPM', (pr) => { pr.bpm = v; }); bpmIn.value = v; if (this.transport) this.transport.resync(); this.refreshUi(); };
    bpmIn.onchange = () => setBpm(+bpmIn.value);
    let taps = [];
    const tap = h('button', { onclick: () => { const n = performance.now(); taps = taps.filter((t) => n - t < 2500); taps.push(n); if (taps.length >= 3) { const d = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); setBpm(60000 / d); } } }, 'Tap');
    const bars = h('select', { 'aria-label': 'Тривалість', onchange: () => { this.store.transact('Тривалість', (pr) => { pr.bars = +bars.value; }); this.fd.vp.setTMax(this.project.bars * 4); this.pr.vp.setTMax(this.project.bars * 4); if (this.transport) this.transport.resync(); this.invalidate(); this.refreshUi(); } },
      [1, 2, 4, 8, 12, 16, 24, 32].map((n) => h('option', { value: n }, `${n} ${n === 1 ? 'такт' : n < 5 ? 'такти' : 'тактів'} (${((n * 4 * 60) / p.bpm).toFixed(1)} с)`)));
    bars.value = p.bars;
    const root = h('select', { 'aria-label': 'Тоніка', onchange: () => { this.store.transact('Лад', (pr) => { pr.scale.root = +root.value; computeAllLines(pr); }); } }, NOTE_LETTERS.map((n, i) => h('option', { value: i }, n)));
    root.value = p.scale.root;
    const type = h('select', { 'aria-label': 'Лад', onchange: () => { this.store.transact('Лад', (pr) => { pr.scale.type = type.value; computeAllLines(pr); }); } }, Object.entries(SCALES).map(([k, v]) => h('option', { value: k }, v.label)));
    type.value = p.scale.type;
    this.openSheet('Темп і лад',
      h('label', { class: 'row' }, h('span', {}, 'BPM'), h('div', { class: 'stepper' }, h('button', { onclick: () => setBpm(+bpmIn.value - 1) }, '−'), bpmIn, h('button', { onclick: () => setBpm(+bpmIn.value + 1) }, '+'), tap)),
      h('label', { class: 'row' }, h('span', {}, 'Тривалість'), bars),
      this.toggle('Зациклити відтворення', () => this.prefs.loop, (v) => { this.prefs.loop = v; this.persistPrefs(); if (this.transport) this.transport.loop = v; }),
      h('h3', {}, 'Музичний лад'),
      h('label', { class: 'row' }, h('span', {}, 'Тоніка'), root), h('label', { class: 'row' }, h('span', {}, 'Лад'), type),
      this.toggle('Підсвічувати ноти ладу', () => this.prefs.showScale, (v) => { this.prefs.showScale = v; this.persistPrefs(); this.invalidate(); }),
      h('p', { class: 'note' }, 'Кнопка «♪ Лад» на панелі інструментів притягує лінії та ноти до цього ладу.'));
  }

  openLineSheet() {
    const f = this.fd.selected && this.fd.findLine(this.fd.selected);
    const body = [
      h('p', { class: 'note' }, f ? 'Змінюючи стиль, ви змінюєте вибрану лінію.' : 'Стиль застосовується до нових ліній. Виберіть лінію інструментом «Вибір», щоб редагувати її.'),
      this.select('Режим', [['smooth', 'Smooth — плавна'], ['natural', 'Natural — як намальовано'], ['sharp', 'Sharp / Stepped — ступені']], () => this.prefs.mode, (v) => { this.prefs.mode = v; this.persistPrefs(); this.fd.applyStyleToSelected(); this.buildToolbar(); }),
      h('label', { class: 'row' }, h('span', {}, 'Інтенсивність'), (() => { const i = h('input', { type: 'range', min: 0, max: 100, value: this.prefs.amount, onchange: () => { this.prefs.amount = +i.value; this.persistPrefs(); this.fd.applyStyleToSelected(); this.buildToolbar(); } }); return i; })()),
      this.toggle('Прив’язка до нот ладу', () => this.prefs.snapScale, (v) => { this.prefs.snapScale = v; this.persistPrefs(); this.fd.applyStyleToSelected(); this.refreshUi(); }),
      this.toggle('Чути тон під час малювання', () => this.prefs.monitor, (v) => { this.prefs.monitor = v; this.persistPrefs(); }),
      this.toggle('Підсвічувати ноти ладу', () => this.prefs.showScale, (v) => { this.prefs.showScale = v; this.persistPrefs(); this.invalidate(); }),
    ];
    if (f) body.push(h('h3', {}, 'Вибрана лінія'), h('div', { class: 'btnrow' },
      h('button', { onclick: () => { this.fd.reverseSelected(); } }, 'Реверс у часі'), h('button', { onclick: () => { this.fd.flipSelected(); } }, 'Віддзеркалити по висоті'),
      h('button', { onclick: () => { this.fd.duplicateSelected(); this.closeSheet(); } }, 'Дублювати'), h('button', { class: 'danger', onclick: () => { this.fd.deleteSelected(); this.closeSheet(); } }, 'Видалити')));
    this.openSheet('Лінія', ...body);
  }

  openNotesSheet() {
    const pr = this.pr, tr = this.activeTrack();
    const sel = pr.notesOf();
    let vel = sel.length ? sel.reduce((a, n) => a + n.v, 0) / sel.length : 0.8;
    const velIn = h('input', { type: 'range', min: 0.05, max: 1, step: 0.01, value: vel, 'aria-label': 'Гучність нот', onchange: () => pr.setVelocity(+velIn.value) });
    let strength = 0.3;
    const body = [
      h('label', { class: 'row' }, h('span', {}, sel.length ? `Гучність (${sel.length})` : 'Гучність (виберіть ноти)'), velIn),
      h('div', { class: 'btnrow' }, h('button', { onclick: () => pr.quantize() }, 'Квантувати'), h('button', { onclick: () => pr.reverse() }, 'Реверс'), h('button', { onclick: () => pr.mirror() }, 'Віддзеркалити')),
      h('h3', {}, 'Генерація'),
      h('div', { class: 'btnrow' },
        h('button', { onclick: () => { const src = sel.length ? sel : tr.notes; this.store.transact('Гармонія', () => { const added = harmonize(tr, src, this.project); pr.sel = new Set(added.map((n) => n.id)); }); this.closeSheet(); } }, 'Додати гармонію (3-я + 5-а)'),
        h('button', { onclick: () => { const bass = synthTracks(this.project).find((t) => t.inst === 'bass' && t.id !== tr.id) || null; this.store.transact('Бас з партії', (p) => { let dst = bass; if (!dst) { dst = createTrack('bass'); p.tracks.splice(p.tracks.indexOf(tr) + 1, 0, dst); } bassFromTrack(tr, dst, p); }); this.toast('Бас створено на окремій доріжці'); this.closeSheet(); } }, 'Створити бас')),
      h('label', { class: 'row' }, h('span', {}, 'Сила мутації'), (() => { const i = h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: strength, oninput: () => { strength = +i.value; } }); return i; })()),
      h('div', { class: 'btnrow' }, h('button', { onclick: () => { let n = 0; this.store.transact('Мутація', () => { n = mutateNotes(tr, this.project, strength); }); this.toast(`Змінено нот: ${n}`); } }, 'Мутувати партію')),
      h('p', { class: 'note' }, 'Усі дії скасовуються кнопкою ↶.'),
    ];
    this.openSheet('Ноти', ...body);
  }

  openAddTrackSheet() {
    const rows = Object.entries(INSTRUMENTS).map(([k, v]) => h('button', { class: 'inst', style: `--c:${v.color}`, onclick: () => {
      let t; this.store.transact('Нова доріжка', (p) => { t = createTrack(k); const idx = p.tracks.findIndex(isDrums); p.tracks.splice(idx < 0 ? p.tracks.length : idx, 0, t); });
      this.setActiveTrack(t.id); this.closeSheet(); } }, h('i'), v.label));
    this.openSheet('Нова доріжка', h('div', { class: 'instgrid' }, rows));
  }

  openTrackSheet(id) {
    const find = () => this.project.tracks.find((t) => t.id === id);
    const t = find(); if (!t) return;
    const upd = (fn) => { const tr = find(); if (tr) fn(tr); };
    const name = h('input', { type: 'text', value: t.name, maxlength: 30, 'aria-label': 'Назва доріжки', onchange: () => { this.store.transact('Назва доріжки', () => upd((tr) => { tr.name = name.value.trim().slice(0, 30) || tr.name; })); this.renderTrackBar(); } });
    const body = [h('label', { class: 'row' }, h('span', {}, 'Назва'), name)];
    if (!isDrums(t)) {
      body.push(
        this.select('Інструмент', Object.entries(INSTRUMENTS).map(([k, v]) => [k, v.label]), () => find().inst, (v) => { this.store.transact('Інструмент', () => upd((tr) => { const b = INSTRUMENTS[v]; Object.assign(tr, { inst: v, wave: b.wave, a: b.a, d: b.d, s: b.s, r: b.r, cutoff: b.cutoff, res: b.res, drive: b.drive, rev: b.rev, dly: b.dly, vol: b.vol }); })); this.openTrackSheet(id); this.renderTrackBar(); }),
        this.select('Хвиля', WAVES.map((w) => [w, w]), () => find().wave, (v) => this.store.transact('Хвиля', () => upd((tr) => { tr.wave = v; }))),
        h('h3', {}, 'ADSR'),
        this.slider('Attack', () => find().a, (v) => upd((tr) => { tr.a = v; }), { min: 0.001, max: 2, step: 0.001, fmt: (v) => v.toFixed(3) + ' с', title: 'ADSR' }),
        this.slider('Decay', () => find().d, (v) => upd((tr) => { tr.d = v; }), { min: 0.01, max: 2, step: 0.005, fmt: (v) => v.toFixed(2) + ' с', title: 'ADSR' }),
        this.slider('Sustain', () => find().s, (v) => upd((tr) => { tr.s = v; }), { title: 'ADSR' }),
        this.slider('Release', () => find().r, (v) => upd((tr) => { tr.r = v; }), { min: 0.02, max: 4, step: 0.01, fmt: (v) => v.toFixed(2) + ' с', title: 'ADSR' }),
        h('h3', {}, 'Фільтр і насичення'),
        this.slider('Cutoff', () => Math.log(find().cutoff / 80) / Math.log(18000 / 80), (v) => upd((tr) => { tr.cutoff = 80 * Math.pow(18000 / 80, v); }), { fmt: (v) => Math.round(80 * Math.pow(18000 / 80, v)) + ' Гц', title: 'Фільтр' }),
        this.slider('Resonance', () => find().res, (v) => upd((tr) => { tr.res = v; }), { min: 0, max: 20, step: 0.1, fmt: (v) => v.toFixed(1) + ' dB', title: 'Фільтр' }),
        this.slider('Drive', () => find().drive, (v) => upd((tr) => { tr.drive = v; }), { title: 'Drive' }));
    }
    body.push(h('h3', {}, 'Мікс'),
      this.slider('Гучність', () => find().vol, (v) => upd((tr) => { tr.vol = v; }), { title: 'Гучність' }),
      this.slider('Панорама', () => find().pan, (v) => upd((tr) => { tr.pan = v; }), { min: -1, max: 1, step: 0.02, fmt: (v) => (v === 0 ? 'C' : v < 0 ? 'L' + Math.round(-v * 100) : 'R' + Math.round(v * 100)), title: 'Панорама' }),
      this.slider('Reverb', () => find().rev, (v) => upd((tr) => { tr.rev = v; }), { title: 'Reverb' }),
      this.slider('Delay', () => find().dly, (v) => upd((tr) => { tr.dly = v; }), { title: 'Delay' }));
    if (!isDrums(t)) body.push(h('div', { class: 'btnrow' },
      h('button', { onclick: () => { let n; this.store.transact('Дублювати доріжку', (p) => { n = JSON.parse(JSON.stringify(find(), (k, v) => (k === 'pts' ? undefined : v))); n.id = uid(); n.name = (n.name + ' 2').slice(0, 30); for (const x of n.notes) x.id = uid(); for (const l of n.lines) l.id = uid(); computeAllLines({ ...p, tracks: [n], scale: p.scale, bars: p.bars }); p.tracks.splice(p.tracks.indexOf(find()) + 1, 0, n); }); this.setActiveTrack(n.id); this.closeSheet(); } }, 'Дублювати'),
      h('button', { class: 'danger', onclick: () => { if (synthTracks(this.project).length < 2) { this.toast('Має залишитись принаймні одна доріжка'); return; } if (!confirm(`Видалити доріжку «${find().name}» з усіма нотами та лініями?`)) return; this.store.transact('Видалити доріжку', (p) => { p.tracks = p.tracks.filter((x) => x.id !== id); }); this.activeTrackId = null; this.closeSheet(); this.renderTrackBar(); } }, 'Видалити доріжку')));
    this.openSheet(t.name, ...body);
  }

  openMasterSheet() {
    const m = () => this.project.master;
    this.openSheet('Майстер',
      this.slider('Гучність', () => m().vol, (v) => { m().vol = v; }, { title: 'Майстер' }),
      this.slider('Reverb', () => m().reverb, (v) => { m().reverb = v; }, { title: 'Майстер' }),
      this.slider('Delay', () => m().delay, (v) => { m().delay = v; }, { title: 'Майстер' }),
      this.slider('Chorus / ширина', () => m().chorus, (v) => { m().chorus = v; }, { title: 'Майстер' }),
      this.slider('Drive', () => m().drive, (v) => { m().drive = v; }, { title: 'Майстер' }),
      h('p', { class: 'note' }, 'Компресор і лімітер завжди ввімкнені: вихід не перевищує 0 dBFS.'));
  }

  // ---------- mixer ----------
  buildMix() {
    const root = $('mixView'); root.innerHTML = '';
    root.append(h('canvas', { id: 'spectrum', 'aria-label': 'Спектр' }));
    const list = h('div', { class: 'mix-list' });
    for (const t of this.project.tracks) {
      const row = h('div', { class: 'mix-row', style: `--c:${trackColor(t)}` },
        h('button', { class: 'mix-name', onclick: () => this.openTrackSheet(t.id) }, h('i'), t.name, h('small', {}, isDrums(t) ? 'Drums' : INSTRUMENTS[t.inst].label)),
        (() => { const s = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Гучність ' + t.name, oninput: () => { this.store.begin(); t.vol = +s.value; this.store.live(); }, onchange: () => this.store.commit('Гучність') }); s.value = t.vol; return s; })(),
        h('button', { class: 'ms' + (t.mute ? ' on' : ''), 'aria-pressed': !!t.mute, onclick: () => this.store.transact('Mute', () => { t.mute = !t.mute; }) }, 'M'),
        h('button', { class: 'ms solo' + (t.solo ? ' on' : ''), 'aria-pressed': !!t.solo, onclick: () => this.store.transact('Solo', () => { t.solo = !t.solo; }) }, 'S'));
      list.append(row);
    }
    root.append(list);
    this.measureSpectrum();
  }
  measureSpectrum() { const c = $('spectrum'); if (!c) return; const r = c.getBoundingClientRect(); c.width = Math.max(1, Math.round(r.width * this.dpr)); c.height = Math.max(1, Math.round(r.height * this.dpr)); }
  drawSpectrum() {
    const c = $('spectrum'); if (!c) return;
    if (c.width < 2) this.measureSpectrum();
    const g = c.getContext('2d'), w = c.width, hh = c.height;
    g.fillStyle = '#0a121c'; g.fillRect(0, 0, w, hh);
    if (!this.engine) return;
    const an = this.engine.analyser, data = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(data);
    const sr = this.engine.ctx.sampleRate, bars = 64;
    const grad = g.createLinearGradient(0, hh, 0, 0); grad.addColorStop(0, '#4be2ad'); grad.addColorStop(1, '#5bc8ff');
    g.fillStyle = grad;
    for (let i = 0; i < bars; i++) {
      const f0 = 20 * Math.pow(800, i / bars), f1 = 20 * Math.pow(800, (i + 1) / bars);
      const b0 = Math.floor((f0 / (sr / 2)) * data.length), b1 = Math.max(b0 + 1, Math.ceil((f1 / (sr / 2)) * data.length));
      let m = 0; for (let b = b0; b < b1 && b < data.length; b++) m = Math.max(m, data[b]);
      const bh = (m / 255) * hh;
      g.fillRect((i / bars) * w + 1, hh - bh, w / bars - 2, bh);
    }
  }

  // ---------- global input ----------
  bindGlobal() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') { if (typing && e.target.type === 'text') return; e.preventDefault(); if (e.shiftKey) this.store.redo(); else this.store.undo(); return; }
      if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); this.store.redo(); return; }
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveNow(); this.toast('Збережено', 900); return; }
      if (typing || !$('sheet').hidden) { if (e.key === 'Escape' && !$('sheet').hidden) this.closeSheet(); return; }
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); return; }
      const ed = this.editors[this.prefs.view];
      if (ed && ed.key && ed.key(e)) { e.preventDefault(); return; }
      if (meta || e.altKey) return;
      const idx = '1234'.indexOf(e.key);
      if (idx >= 0) { this.setView(VIEWS[idx][0]); return; }
      const toolKey = { d: 'draw', s: 'select', e: 'erase' }[e.key.toLowerCase()];
      if (toolKey && ed) { this.prefs.tool = toolKey; this.persistPrefs(); this.refreshUi(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.saveNow(); if (this.transport) this.transport.stop(); } });
    window.addEventListener('pagehide', () => this.saveNow());
    window.addEventListener('error', (e) => { this.lastError = e.message; });
    // block iOS rubber banding / pinch-zoom of the page itself
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('touchmove', (e) => { if (e.target.closest && e.target.closest('canvas, .drum-steps')) e.preventDefault(); }, { passive: false });
  }
}

window.__dys = new App();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
