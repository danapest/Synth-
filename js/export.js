// File export: offline WAV render (same engine + scheduler as live playback), MIDI, JSON download.
import { Engine } from './audio.js';
import { Scheduler } from './transport.js';
import { totalBeats, isDrums, exportPayload } from './model.js';

export async function renderProject(project, { sampleRate = 44100, tail = 2.5, onProgress } = {}) {
  const O = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const total = totalBeats(project);
  const lead = 0.05;
  const seconds = (total * 60) / project.bpm + tail + lead;
  const ctx = new O(2, Math.ceil(seconds * sampleRate), sampleRate);
  const engine = new Engine(ctx);
  engine.syncTracks(project.tracks);
  engine.setMaster(project.master, project.bpm);
  const sched = new Scheduler(engine, () => project, (abs) => lead + (abs * 60) / project.bpm);
  sched.span(0, total, 0, -1e9);
  if (onProgress) onProgress(0.2);
  const buf = await ctx.startRendering();
  if (onProgress) onProgress(1);
  return buf;
}

export function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, data[c][i]));
    out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

// ---- MIDI (format 1, 480 PPQ). Free-draw lines have no note equivalent and are skipped. ----
const GM_DRUM = { kick: 36, snare: 38, clap: 39, hatc: 42, hato: 46, perc: 47 };
const vlq = (v) => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); return b; };
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v) => [(v >> 8) & 255, v & 255];
const chunk = (id, bytes) => [...id].map((c) => c.charCodeAt(0)).concat(u32(bytes.length), bytes);

export function buildMidi(project) {
  const PPQ = 480;
  const tracks = [];
  const mpqn = Math.round(60000000 / project.bpm);
  tracks.push(chunk('MTrk', [0, 0xff, 0x51, 3, (mpqn >> 16) & 255, (mpqn >> 8) & 255, mpqn & 255, 0, 0xff, 0x03, ...[...'Tempo'].map((c) => c.charCodeAt(0)), 0, 0xff, 0x2f, 0]));
  let ch = 0;
  for (const tr of project.tracks) {
    const events = []; // {tick, bytes}
    let channel;
    if (isDrums(tr)) {
      channel = 9;
      const steps = totalBeats(project) * 4;
      for (const lane of project.drums.lanes) for (let s = 0; s < steps; s++) {
        const v = lane.steps[s % lane.len];
        if (!v) continue;
        const tick = Math.round(s * 0.25 * PPQ);
        events.push({ tick, bytes: [0x99, GM_DRUM[lane.id] || 37, Math.round(40 + 87 * v)] });
        events.push({ tick: tick + 60, bytes: [0x89, GM_DRUM[lane.id] || 37, 0] });
      }
    } else {
      channel = ch++ % 9;
      for (const n of tr.notes) {
        const on = Math.round(n.t * PPQ), off = Math.max(on + 1, Math.round((n.t + n.d) * PPQ));
        events.push({ tick: on, bytes: [0x90 | channel, n.m, Math.round(30 + 97 * n.v)] });
        events.push({ tick: off, bytes: [0x80 | channel, n.m, 0] });
      }
    }
    if (!events.length) continue;
    events.sort((a, b) => a.tick - b.tick || (a.bytes[0] & 0xf0) - (b.bytes[0] & 0xf0));
    const body = [0, 0xff, 0x03, tr.name.length, ...[...tr.name].map((c) => c.charCodeAt(0) & 127)];
    let last = 0;
    for (const e of events) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(0, 0xff, 0x2f, 0);
    tracks.push(chunk('MTrk', body));
  }
  const header = chunk('MThd', [...u16(1), ...u16(tracks.length), ...u16(PPQ)]);
  return new Uint8Array([...header, ...tracks.flat()]);
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export const safeName = (s) => (s || 'project').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'project';
export const downloadJson = (project) => download(new Blob([exportPayload(project)], { type: 'application/json' }), safeName(project.name) + '.dys.json');
export const downloadMidi = (project) => download(new Blob([buildMidi(project)], { type: 'audio/midi' }), safeName(project.name) + '.mid');
export async function downloadWav(project, onProgress) {
  const buf = await renderProject(project, { onProgress });
  download(encodeWav(buf), safeName(project.name) + '.wav');
}
