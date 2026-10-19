// Pure data: instrument presets and drum lanes. No Web Audio here so it is unit-testable.
export const INSTRUMENTS = {
  lead: { label: 'Lead', color: '#5bc8ff', wave: 'sawtooth', a: 0.012, d: 0.18, s: 0.65, r: 0.22, cutoff: 5200, res: 3, drive: 0.2, vol: 0.75, pan: 0, rev: 0.22, dly: 0.22 },
  bass: { label: 'Sub Bass', color: '#4be2ad', wave: 'sawtooth', a: 0.006, d: 0.2, s: 0.8, r: 0.12, cutoff: 520, res: 4, drive: 0.35, vol: 0.9, pan: 0, rev: 0.03, dly: 0 },
  pad: { label: 'Pad', color: '#c792ea', wave: 'sawtooth', a: 0.7, d: 0.8, s: 0.8, r: 1.4, cutoff: 2200, res: 0, drive: 0, vol: 0.6, pan: 0, rev: 0.5, dly: 0.2 },
  acid: { label: 'Acid', color: '#ffb454', wave: 'sawtooth', a: 0.003, d: 0.16, s: 0.35, r: 0.08, cutoff: 420, res: 14, drive: 0.5, vol: 0.7, pan: 0, rev: 0.1, dly: 0.3 },
  perc: { label: 'Perc', color: '#ff6b8b', wave: 'sine', a: 0.001, d: 0.22, s: 0, r: 0.08, cutoff: 9000, res: 0, drive: 0.1, vol: 0.85, pan: 0, rev: 0.15, dly: 0.1 },
  fm: { label: 'FM Bell', color: '#f2e35c', wave: 'sine', a: 0.002, d: 0.9, s: 0.15, r: 0.6, cutoff: 12000, res: 0, drive: 0, vol: 0.7, pan: 0, rev: 0.35, dly: 0.25 },
};
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];

export const DRUM_COLOR = '#ff8a5b';
export const DRUM_LANES = [
  { id: 'kick', name: 'Kick' },
  { id: 'snare', name: 'Snare' },
  { id: 'clap', name: 'Clap' },
  { id: 'hatc', name: 'Hat closed' },
  { id: 'hato', name: 'Hat open' },
  { id: 'perc', name: 'Perc' },
];

export const DRUM_PRESETS = {
  'Four on floor': { kick: '1000100010001000', snare: '0000100000001000', clap: '0000000000001000', hatc: '0010001000100010', hato: '0000000100000001', perc: '0000000000100000' },
  Breakbeat: { kick: '1000001000100000', snare: '0000100000001001', clap: '0000000000000000', hatc: '1010101010101010', hato: '0000000000000010', perc: '0100000001000100' },
  Halftime: { kick: '1000000000100000', snare: '0000000010000000', clap: '0000000010000000', hatc: '1010101010101010', hato: '0000000000000010', perc: '0000001000000000' },
};
