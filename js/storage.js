// localStorage persistence: multiple projects, two-slot writes (current + backup),
// legacy migration. Every access is wrapped: storage may be blocked or full.
import { sanitizeProject, serialize, createProject } from './model.js';

const IDX = 'dys:index';
const CUR = 'dys:current';
const PREFS = 'dys:prefs';
const LEGACY = 'drawsound-v1';
const pk = (id) => 'dys:p:' + id;
const bk = (id) => 'dys:b:' + id;

let ls = null;
try { ls = window.localStorage; ls.getItem('x'); } catch (e) { ls = null; }

const get = (k) => { try { return ls ? ls.getItem(k) : null; } catch (e) { return null; } };
const set = (k, v) => { if (!ls) throw new Error('Сховище недоступне'); ls.setItem(k, v); };
const del = (k) => { try { ls && ls.removeItem(k); } catch (e) { /* ignore */ } };

export function listProjects() {
  try { const a = JSON.parse(get(IDX) || '[]'); return Array.isArray(a) ? a.filter((x) => x && typeof x.id === 'string') : []; } catch (e) { return []; }
}
function writeIndex(list) { set(IDX, JSON.stringify(list)); }

export function saveProject(project) {
  const key = pk(project.id);
  const data = serialize(project);
  const prev = get(key);
  if (prev && prev !== data) { try { set(bk(project.id), prev); } catch (e) { /* backup is best effort */ } }
  set(key, data);
  const list = listProjects().filter((x) => x.id !== project.id);
  list.unshift({ id: project.id, name: project.name, updated: project.updated });
  writeIndex(list);
  set(CUR, project.id);
}

function parseSlot(k) {
  const s = get(k);
  if (!s) return null;
  try { return sanitizeProject(JSON.parse(s)); } catch (e) { return null; }
}

export function loadProject(id) {
  return parseSlot(pk(id)) || parseSlot(bk(id));
}

export function deleteProject(id) {
  del(pk(id)); del(bk(id));
  writeIndex(listProjects().filter((x) => x.id !== id));
}

export function loadLastProject() {
  const id = get(CUR);
  let p = id ? loadProject(id) : null;
  if (!p) for (const e of listProjects()) { p = loadProject(e.id); if (p) break; }
  if (!p) {
    const legacy = get(LEGACY);
    if (legacy) { try { p = sanitizeProject(JSON.parse(legacy)); } catch (e) { p = null; } }
  }
  return p || createProject();
}

export function loadPrefs() { try { return JSON.parse(get(PREFS) || '{}') || {}; } catch (e) { return {}; } }
export function savePrefs(o) { try { set(PREFS, JSON.stringify(o)); } catch (e) { /* ignore */ } }
