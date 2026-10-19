// Holds the current project and its undo/redo history.
// One user gesture == one history entry: call begin() when the gesture starts,
// mutate the project freely (emit 'live'), and commit() when it ends.
import { serialize, computeAllLines } from './model.js';

const MAX_HISTORY = 200;

export class Store {
  constructor(project) {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.listeners = {};
    computeAllLines(project);
  }
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); return () => { this.listeners[evt] = this.listeners[evt].filter((f) => f !== fn); }; }
  emit(evt, arg) { for (const fn of this.listeners[evt] || []) fn(arg); }

  load(project) {
    this.project = project;
    this.undoStack = []; this.redoStack = []; this.pending = null;
    computeAllLines(project);
    this.emit('load');
    this.emit('commit', { reason: 'load' });
  }
  snapshot() { return serialize(this.project); }

  begin() { if (this.pending === null) this.pending = this.snapshot(); }
  live() { this.emit('live'); }
  commit(label = '') {
    const before = this.pending;
    this.pending = null;
    if (before === null) return false;
    const after = this.snapshot();
    if (after === before) { this.emit('live'); return false; }
    this.undoStack.push({ s: before, label });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.project.updated = Date.now();
    this.emit('commit', { reason: 'edit', label });
    return true;
  }
  cancel() {
    if (this.pending === null) return;
    const snap = this.pending;
    this.pending = null;
    this.restore(snap);
    this.emit('live');
  }
  // Atomic discrete operation.
  transact(label, fn) {
    this.begin();
    try { fn(this.project); } catch (e) { this.cancel(); throw e; }
    return this.commit(label);
  }
  restore(snap) {
    const p = JSON.parse(snap);
    for (const k of Object.keys(this.project)) delete this.project[k];
    Object.assign(this.project, p);
    computeAllLines(this.project);
  }
  get canUndo() { return this.undoStack.length > 0 && this.pending === null; }
  get canRedo() { return this.redoStack.length > 0 && this.pending === null; }
  undo() {
    if (!this.canUndo) return false;
    const e = this.undoStack.pop();
    this.redoStack.push({ s: this.snapshot(), label: e.label });
    this.restore(e.s);
    this.project.updated = Date.now();
    this.emit('commit', { reason: 'undo', label: e.label });
    return true;
  }
  redo() {
    if (!this.canRedo) return false;
    const e = this.redoStack.pop();
    this.undoStack.push({ s: this.snapshot(), label: e.label });
    this.restore(e.s);
    this.project.updated = Date.now();
    this.emit('commit', { reason: 'redo', label: e.label });
    return true;
  }
}
