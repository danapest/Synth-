export const SCALES = {
  major: { label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  pentMajor: { label: 'Pentatonic maj', steps: [0, 2, 4, 7, 9] },
  pentMinor: { label: 'Pentatonic min', steps: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  chromatic: { label: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export const inScale = (midi, root, type) => {
  const s = (SCALES[type] || SCALES.minor).steps;
  return s.includes((((Math.round(midi) - root) % 12) + 12) % 12);
};

// Nearest in-scale integer MIDI note to a (fractional) pitch.
export function nearestScaleMidi(p, root, type) {
  const base = Math.round(p);
  let best = base;
  let dist = Infinity;
  for (let c = base - 7; c <= base + 7; c++) {
    if (!inScale(c, root, type)) continue;
    const d = Math.abs(c - p);
    if (d < dist) { dist = d; best = c; }
  }
  return best;
}

// Move `degrees` scale degrees up (or down) from the nearest in-scale note.
export function shiftByDegrees(midi, degrees, root, type) {
  let m = nearestScaleMidi(midi, root, type);
  const dir = Math.sign(degrees);
  for (let i = 0; i < Math.abs(degrees); i++) {
    do { m += dir; } while (!inScale(m, root, type) && Math.abs(m - midi) < 40);
  }
  return m;
}
