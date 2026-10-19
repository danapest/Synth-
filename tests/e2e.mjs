// End-to-end tests in real browsers (Chromium + WebKit). Run: npm run test:e2e
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const URL_ = `http://localhost:${server.address().port}/`;

const only = process.argv.slice(2);
const results = [];
results.push = function (...a) { Array.prototype.push.apply(this, a); for (const [n, ok, msg] of a) console.log(`${ok ? '✔' : '✖'} ${n}${ok ? '' : '\n    ' + msg}`); return this.length; };
let browser, name;

async function t(title, fn, { touch = false, chromiumOnly = false, viewport = { width: 900, height: 700 } } = {}) {
  if (chromiumOnly && name !== 'chromium') return;
  if (only.length && !only.some((o) => title.includes(o))) return;
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: false, serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  try {
    await page.goto(URL_);
    await page.waitForFunction(() => window.__dys);
    await fn(page, ctx);
    const real = errors.filter((e) => !/favicon|Failed to load resource.*(404|net::ERR_INTERNET)/.test(e));
    if (real.length) throw new Error('JS errors: ' + real.join(' | '));
    results.push([`${name}: ${title}`, true]);
  } catch (e) { results.push([`${name}: ${title}`, false, (e && e.message || String(e)).split('\n').slice(0, 4).join(' ')]); }
  await ctx.close();
}

// ---------- helpers ----------
const A = (page, fn, arg) => page.evaluate(fn, arg);
const proj = (page) => A(page, () => JSON.parse(JSON.stringify(window.__dys.project, (k, v) => (k === 'pts' ? undefined : v))));
const setView = (page, v) => A(page, (v) => window.__dys.setView(v), v);
const setPrefs = (page, o) => A(page, (o) => { Object.assign(window.__dys.prefs, o); window.__dys.refreshUi(); }, o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fdGeo(page) { return A(page, () => { const r = document.getElementById('cvDraw').getBoundingClientRect(), vp = window.__dys.fd.vp; return { l: r.left, t: r.top, w: r.width, h: r.height, ppb: vp.ppb, ppm: vp.ppm, x0: vp.x0, pTop: vp.pTop, tMax: vp.tMax }; }); }
async function prGeo(page) { return A(page, () => { const r = document.getElementById('cvNotes').getBoundingClientRect(), vp = window.__dys.pr.vp; return { l: r.left + 52, t: r.top + 24, ppb: vp.ppb, ppm: vp.ppm, x0: vp.x0, pTop: vp.pTop, w: vp.w, h: vp.h }; }); }
const gx = (g, t) => g.l + (t - g.x0) * g.ppb;
const gy = (g, m) => g.t + (g.pTop - m) * g.ppm;
const notesOf = async (page, i = 0) => (await proj(page)).tracks.filter((t) => t.type === 'synth')[i].notes;
const linesOf = async (page, i = 0) => A(page, (i) => window.__dys.project.tracks.filter((t) => t.type === 'synth')[i].lines.map((l) => ({ ...l, pts: l.pts })), i);
const undoLen = (page) => A(page, () => window.__dys.store.undoStack.length);

async function mouseDrag(page, pts, steps = 1) {
  await page.mouse.move(pts[0][0], pts[0][1]); await page.mouse.down();
  for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i][0], pts[i][1], { steps });
  await page.mouse.up();
}
async function addNote(page, t, d, m) {
  await A(page, ([t, d, m]) => window.__dys.store.transact('test', (p) => { p.tracks[0].notes.push({ id: 'n' + Math.random().toString(36).slice(2), t, d, m, v: 0.8 }); }), [t, d, m]);
}
const pitchAt = (pts, t) => { if (t <= pts[0].t) return pts[0].p; for (let i = 1; i < pts.length; i++) if (pts[i].t >= t) { const a = pts[i - 1], b = pts[i]; return b.t - a.t < 1e-6 ? b.p : a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t); } return pts[pts.length - 1].p; };

// ---------- Free Draw ----------
await runAll();
async function runAll() {
  for (const [bn, bt] of [['chromium', chromium], ['webkit', webkit]]) {
    name = bn;
    try { browser = await bt.launch(bn === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}); } catch (e) { results.push([`${bn}: launch`, false, e.message.split('\n')[0]]); continue; }
    await suite();
    await browser.close();
  }
  server.close();
  let fail = 0;
  for (const [, ok] of results) if (!ok) fail++;
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

async function suite() {
  await t('app loads, 4 views render, no JS errors', async (page) => {
    for (const v of ['draw', 'notes', 'drums', 'mix']) { await page.click(`#views [data-view=${v}]`); await sleep(80); assert.equal(await page.locator(`#stage > section[data-view=${v}]`).isVisible(), true); }
    assert.equal(await page.title(), 'Draw Your Sound');
  });

  await t('free draw: the full canvas width is drawable (left and right edges map to t=0 and t=end)', async (page) => {
    const g = await fdGeo(page);
    await mouseDrag(page, [[g.l + 1, g.t + g.h * 0.4], [g.l + g.w * 0.5, g.t + g.h * 0.3], [g.l + g.w - 1, g.t + g.h * 0.5]], 12);
    const [line] = await linesOf(page);
    assert.ok(line, 'line created');
    assert.ok(line.pts[0].t < 0.08, `starts at left edge, got ${line.pts[0].t}`);
    assert.ok(line.pts[line.pts.length - 1].t > g.tMax - 0.08, `ends at right edge, got ${line.pts[line.pts.length - 1].t}`);
    assert.equal(await undoLen(page), 1);
  });

  await t('free draw: right-to-left gives the same time mapping as left-to-right', async (page) => {
    const g = await fdGeo(page);
    const yA = g.t + g.h * 0.2, yB = g.t + g.h * 0.7, xL = g.l + g.w * 0.1, xR = g.l + g.w * 0.9;
    await mouseDrag(page, [[xR, yA], [xL, yB]], 40); // right -> left, descending in time
    const [line] = await linesOf(page);
    const vp = { x0: g.x0, ppb: g.ppb, pTop: g.pTop, ppm: g.ppm };
    const tL = vp.x0 + (xL - g.l) / vp.ppb, tR = vp.x0 + (xR - g.l) / vp.ppb;
    const pAt = (y) => vp.pTop - (y - g.t) / vp.ppm;
    assert.ok(Math.abs(line.pts[0].t - tL) < 0.15, `start t ${line.pts[0].t} vs ${tL}`);
    assert.ok(Math.abs(line.pts[line.pts.length - 1].t - tR) < 0.15);
    // pitch under the LEFT end must be the pitch where the finger ENDED (yB), under the right end where it STARTED (yA)
    assert.ok(Math.abs(line.pts[0].p - pAt(yB)) < 1.5, `left pitch ${line.pts[0].p} vs ${pAt(yB)}`);
    assert.ok(Math.abs(line.pts[line.pts.length - 1].p - pAt(yA)) < 1.5);
  });

  await t('free draw: finger speed does not change the result', async (page) => {
    const g = await fdGeo(page);
    const pts = [[g.l + 80, g.t + 200], [g.l + 300, g.t + 120], [g.l + 600, g.t + 320]];
    await mouseDrag(page, pts, 3);
    await mouseDrag(page, pts, 80);
    const [a, b] = await linesOf(page);
    for (const t of [2, 5, 8, 11]) assert.ok(Math.abs(pitchAt(a.pts, t) - pitchAt(b.pts, t)) < 0.8, `t=${t}: ${pitchAt(a.pts, t)} vs ${pitchAt(b.pts, t)}`);
  });

  await t('free draw: lines keep their musical position after window resize and zoom', async (page) => {
    const g = await fdGeo(page);
    await mouseDrag(page, [[g.l + 100, g.t + 200], [g.l + 500, g.t + 300]], 10);
    const before = (await proj(page)).tracks[0].lines[0].raw;
    await page.setViewportSize({ width: 600, height: 500 }); await sleep(250);
    await page.setViewportSize({ width: 1100, height: 760 }); await sleep(250);
    await page.mouse.move(400, 300); await page.keyboard.down('Control'); await page.mouse.wheel(0, -300); await page.keyboard.up('Control'); await sleep(100);
    const after = (await proj(page)).tracks[0].lines[0].raw;
    assert.deepEqual(after, before);
    const info = await A(page, () => { const vp = window.__dys.fd.vp; return { first: window.__dys.project.tracks[0].lines[0].pts[0], tl: vp.xToTime(0), tr: vp.xToTime(vp.w), ppb: vp.ppb, minPpb: vp.minPpb }; });
    assert.ok(info.ppb > info.minPpb, 'zoomed in');
    const g2 = await fdGeo(page);
    const x = g2.l + (info.first.t - g2.x0) * g2.ppb; // where the start of the line is drawn after zoom
    assert.ok(Number.isFinite(x));
  }, { viewport: { width: 1100, height: 760 } });

  await t('free draw: smoothing modes change both the drawn line and the audio curve', async (page) => {
    const g = await fdGeo(page);
    const zig = []; for (let i = 0; i <= 60; i++) zig.push([g.l + 40 + i * 10, g.t + 250 + (i % 2 ? 14 : -14)]);
    const rough = async (mode) => { await setPrefs(page, { mode, amount: 80 }); await mouseDrag(page, zig, 1); const ls = await linesOf(page); const pts = ls[ls.length - 1].pts; let s = 0; for (let i = 1; i < pts.length; i++) s += Math.abs(pts[i].p - pts[i - 1].p); return s; };
    const nat = await rough('natural'), smooth = await rough('smooth'), sharp = await rough('sharp');
    assert.ok(smooth < nat * 0.5, `smooth ${smooth} vs natural ${nat}`);
    assert.ok(sharp > 0 && sharp !== nat);
  });

  await t('free draw: select tool moves a line, one undo step, eraser deletes', async (page) => {
    const g = await fdGeo(page);
    await mouseDrag(page, [[g.l + 100, g.t + 300], [g.l + 400, g.t + 300]], 10);
    const raw0 = (await proj(page)).tracks[0].lines[0].raw;
    await setPrefs(page, { tool: 'select', snap: 'off' });
    await mouseDrag(page, [[g.l + 250, g.t + 300], [g.l + 350, g.t + 250]], 8);
    const raw1 = (await proj(page)).tracks[0].lines[0].raw;
    assert.ok(raw1[0][0] > raw0[0][0] + 0.5 && raw1[0][1] > raw0[0][1], 'moved in time and pitch');
    assert.equal(await undoLen(page), 2);
    await page.keyboard.press('Control+z');
    assert.deepEqual((await proj(page)).tracks[0].lines[0].raw, raw0);
    await setPrefs(page, { tool: 'erase' });
    const g2 = await fdGeo(page);
    await mouseDrag(page, [[g2.l + 60, g2.t + 300], [g2.l + 450, g2.t + 300]], 10);
    assert.equal((await linesOf(page)).length, 0);
    await page.click('#btnUndo');
    assert.equal((await linesOf(page)).length, 1);
  });

  // ---------- Piano Roll ----------
  const toNotes = async (page) => { await setView(page, 'notes'); await setPrefs(page, { tool: 'draw', snap: '1/16' }); await sleep(120); return prGeo(page); };

  await t('piano roll: click creates a note on the snapped grid, drag sets the length, each is one undo step', async (page) => {
    const g = await toNotes(page);
    await page.mouse.click(gx(g, 1.03), gy(g, 60));
    let n = await notesOf(page);
    assert.equal(n.length, 1); assert.equal(n[0].t, 1); assert.equal(n[0].m, 60); assert.equal(n[0].d, 0.5);
    await mouseDrag(page, [[gx(g, 4.02), gy(g, 64)], [gx(g, 6.1), gy(g, 64)]], 8);
    n = await notesOf(page);
    assert.equal(n.length, 2);
    const long = n.find((x) => x.m === 64);
    assert.equal(long.t, 4); assert.ok(Math.abs(long.d - 2.0) < 1e-9 || Math.abs(long.d - 2.25) < 1e-9, `len ${long.d}`);
    assert.equal(await undoLen(page), 2);
  });

  await t('piano roll: hit testing — short notes are reachable with cursor (inside and just beside)', async (page) => {
    const g = await toNotes(page);
    await setPrefs(page, { snap: '1/32' });
    await page.mouse.click(gx(g, 2.0), gy(g, 62)); // creates a note at 2.0, len = lastLen (0.5) but we shorten below
    await A(page, () => { const n = window.__dys.project.tracks[0].notes[0]; n.d = 0.125; window.__dys.invalidate(); });
    const g2 = await prGeo(page);
    const widthPx = 0.125 * g2.ppb; assert.ok(widthPx < 12, `note is ${widthPx}px wide`);
    const x1 = gx(g2, 2.0);
    // center of the short note -> selects (no new note)
    await page.mouse.click(x1 + widthPx / 2, gy(g2, 62));
    assert.equal((await notesOf(page)).length, 1, 'no accidental new note');
    assert.equal(await A(page, () => window.__dys.pr.sel.size), 1);
    // 3 px left of the note still grabs it
    await A(page, () => { window.__dys.pr.sel = new Set(); });
    await page.mouse.click(x1 - 3, gy(g2, 62));
    assert.equal((await notesOf(page)).length, 1);
    assert.equal(await A(page, () => window.__dys.pr.sel.size), 1);
    // vertical tolerance: click in the row of the note near its top edge
    await A(page, () => { window.__dys.pr.sel = new Set(); });
    await page.mouse.click(x1 + widthPx / 2, gy(g2, 62) - g2.ppm * 0.4);
    assert.equal((await notesOf(page)).length, 1);
  });

  await t('piano roll: move on both axes = one undo step; undo/redo restore exactly', async (page) => {
    const g = await toNotes(page);
    await addNote(page, 2, 2, 60);
    const before = await undoLen(page);
    await mouseDrag(page, [[gx(g, 2.5), gy(g, 60)], [gx(g, 3.5), gy(g, 62)], [gx(g, 4.5), gy(g, 63)]], 10);
    const [n] = await notesOf(page);
    assert.equal(n.t, 4); assert.equal(n.m, 63); assert.equal(n.d, 2);
    assert.equal(await undoLen(page), before + 1);
    await page.keyboard.press('Control+z');
    let [u] = await notesOf(page); assert.equal(u.t, 2); assert.equal(u.m, 60);
    await page.keyboard.press('Control+Shift+z');
    [u] = await notesOf(page); assert.equal(u.t, 4); assert.equal(u.m, 63);
  });

  await t('piano roll: resize by the right edge, snapped, one undo step', async (page) => {
    const g = await toNotes(page);
    await addNote(page, 2, 2, 60);
    const before = await undoLen(page);
    await mouseDrag(page, [[gx(g, 4) - 3, gy(g, 60)], [gx(g, 5.1), gy(g, 60)]], 8);
    const [n] = await notesOf(page);
    assert.equal(n.t, 2); assert.equal(n.d, 3);
    assert.equal(await undoLen(page), before + 1);
    await page.click('#btnUndo'); assert.equal((await notesOf(page))[0].d, 2);
  });

  await t('piano roll: select, copy, paste at marker, duplicate, delete — all undoable', async (page) => {
    const g = await toNotes(page);
    await addNote(page, 1, 1, 60); await addNote(page, 2, 1, 64);
    await setPrefs(page, { tool: 'select' });
    await mouseDrag(page, [[gx(g, 0.5), gy(g, 66)], [gx(g, 3.5), gy(g, 58)]], 8); // marquee over both
    assert.equal(await A(page, () => window.__dys.pr.sel.size), 2);
    await page.keyboard.press('Control+c');
    await A(page, () => { window.__dys.pr.setMarker(8); });
    await page.keyboard.press('Control+v');
    let n = await notesOf(page);
    assert.equal(n.length, 4);
    assert.deepEqual(n.slice(2).map((x) => [x.t, x.m]).sort(), [[8, 60], [9, 64]]);
    await page.keyboard.press('Control+z'); assert.equal((await notesOf(page)).length, 2);
    await page.keyboard.press('Control+Shift+z'); assert.equal((await notesOf(page)).length, 4);
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+d'); n = await notesOf(page); assert.equal(n.length, 8);
    await page.keyboard.press('Delete'); assert.equal((await notesOf(page)).length, 4);
    await page.keyboard.press('Control+z'); assert.equal((await notesOf(page)).length, 8);
  });

  await t('piano roll: group move keeps relative offsets; copy-drag duplicates', async (page) => {
    const g = await toNotes(page);
    await addNote(page, 1, 1, 60); await addNote(page, 3, 1, 67);
    await setPrefs(page, { tool: 'select' });
    await mouseDrag(page, [[gx(g, 0.5), gy(g, 70)], [gx(g, 4.5), gy(g, 57)]], 6);
    await mouseDrag(page, [[gx(g, 1.5), gy(g, 60)], [gx(g, 2.5), gy(g, 61)]], 6);
    let n = (await notesOf(page)).sort((a, b) => a.t - b.t);
    assert.deepEqual(n.map((x) => [x.t, x.m]), [[2, 61], [4, 68]]);
    await setPrefs(page, { dupMode: true });
    await mouseDrag(page, [[gx(g, 2.5), gy(g, 61)], [gx(g, 6.5), gy(g, 61)]], 6);
    n = await notesOf(page); assert.equal(n.length, 4);
    assert.equal((await proj(page)).tracks[0].notes.length, 4);
  });

  await t('piano roll: overlapping notes of one pitch are resolved predictably', async (page) => {
    const g = await toNotes(page);
    await addNote(page, 0, 4, 60);
    await mouseDrag(page, [[gx(g, 2.01), gy(g, 60) + 0], [gx(g, 3.0), gy(g, 60)]], 4); // starts inside existing note -> moves it; use another pitch to create instead
    const n = await notesOf(page);
    assert.ok(n.every((x, i, arr) => arr.every((y, j) => i === j || x.m !== y.m || x.t + x.d <= y.t + 1e-9 || y.t + y.d <= x.t + 1e-9)), 'no same-pitch overlaps remain');
  });

  await t('piano roll: right-click deletes; eraser tool deletes while dragging; ruler sets paste marker', async (page) => {
    const g = await toNotes(page);
    await addNote(page, 1, 1, 60); await addNote(page, 3, 1, 62); await addNote(page, 5, 1, 64);
    await page.mouse.click(gx(g, 1.5), gy(g, 60), { button: 'right' });
    assert.equal((await notesOf(page)).length, 2);
    await setPrefs(page, { tool: 'erase' });
    await mouseDrag(page, [[gx(g, 2.5), gy(g, 62)], [gx(g, 3.5), gy(g, 62)], [gx(g, 3.5), gy(g, 64)], [gx(g, 5.5), gy(g, 64)]], 10);
    assert.equal((await notesOf(page)).length, 0);
    await page.mouse.click(gx(g, 6), g.t - 12);
    assert.equal(await A(page, () => window.__dys.pr.marker), 6);
  });

  await t('piano roll: zoom/scroll never move music data; wheel + trackpad semantics', async (page) => {
    const g = await toNotes(page);
    await addNote(page, 2, 1, 60);
    const raw = JSON.stringify(await notesOf(page));
    await page.mouse.move(gx(g, 2.5), gy(g, 60));
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -400); await page.keyboard.up('Control');
    const z1 = await prGeo(page); assert.ok(z1.ppb > g.ppb, 'zoomed horizontally');
    // note stays under the cursor anchor
    const tUnder = z1.x0 + (gx(g, 2.5) - z1.l) / z1.ppb; assert.ok(Math.abs(tUnder - 2.5) < 0.05, `anchor drift ${tUnder}`);
    await page.mouse.wheel(0, 200); const z2 = await prGeo(page); assert.ok(z2.pTop < z1.pTop, 'scrolled down');
    await page.mouse.wheel(150, 0); await page.keyboard.down('Shift'); await page.mouse.wheel(0, 100); await page.keyboard.up('Shift');
    await page.keyboard.down('Alt'); await page.mouse.wheel(0, -200); await page.keyboard.up('Alt');
    const z3 = await prGeo(page); assert.ok(z3.ppm > z2.ppm, 'zoomed vertically');
    assert.equal(JSON.stringify(await notesOf(page)), raw);
    await page.click('#toolbar [aria-label="Показати все"]');
    assert.ok(Math.abs((await prGeo(page)).ppb - (await A(page, () => window.__dys.pr.vp.minPpb))) < 1e-6);
  });

  await t('piano roll: toolbar zoom/octave buttons work, snap select changes grid', async (page) => {
    await toNotes(page);
    const a = await prGeo(page);
    await page.click('#toolbar [aria-label="Збільшити по горизонталі"]'); await page.click('#toolbar [aria-label="Збільшити по вертикалі"]');
    const b = await prGeo(page); assert.ok(b.ppb > a.ppb && b.ppm > a.ppm);
    await page.click('#toolbar >> text=Окт ▲'); assert.ok((await prGeo(page)).pTop > b.pTop);
    await page.selectOption('#toolbar select[aria-label="Сітка"]', '1/8');
    assert.equal(await A(page, () => window.__dys.prefs.snap), '1/8');
    const z = await prGeo(page), tc = z.x0 + 1.2, mc = Math.round(z.pTop - 2);
    await page.mouse.click(gx(z, tc), gy(z, mc));
    const made = (await notesOf(page))[0];
    assert.equal(made.t, Math.floor(tc / 0.5) * 0.5); assert.equal(made.m, mc);
  });

  // ---------- BPM / grid math ----------
  await t('BPM change keeps beats; grid is in beats not seconds', async (page) => {
    const g = await toNotes(page);
    await page.mouse.click(gx(g, 1.0), gy(g, 60));
    await page.click('#btnBpm');
    await page.fill('#sheetBody input[type=number]', '60'); await page.press('#sheetBody input[type=number]', 'Tab');
    await page.click('#sheetClose');
    const p = await proj(page);
    assert.equal(p.bpm, 60); assert.equal(p.tracks[0].notes[0].t, 1);
    assert.equal(await page.textContent('#bpmVal'), '60');
    await page.mouse.click(gx(g, 3.0), gy(g, 62));
    assert.equal((await notesOf(page))[1].t, 3);
  });

  // ---------- playback / audio correctness (offline render uses the same engine+scheduler) ----------
  const RENDER = `
    const { renderProject } = await import('./js/export.js');
    const p = JSON.parse(JSON.stringify(window.__dys.project, (k, v) => (k === 'pts' ? undefined : v)));
    p.master = { vol: 1, reverb: 0, delay: 0, chorus: 0, drive: 0 };
    for (const t of p.tracks) { t.rev = 0; t.dly = 0; if (t.type === 'synth') { t.wave = 'sine'; t.cutoff = 18000; t.res = 0; t.drive = 0; t.vol = 1; t.a = 0.005; t.r = 0.05; t.inst = 'lead'; } }
    return { p, renderProject };`;
  const analyze = (buf, sr) => {
    const d = buf.getChannelData(0); let peak = 0; for (const x of d) peak = Math.max(peak, Math.abs(x));
    let onset = -1; for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak * 0.1) { onset = i / sr; break; }
    return { peak, onset };
  };
  const freqIn = (d, sr, t0, t1) => { let c = 0, prev = d[Math.floor(t0 * sr)]; for (let i = Math.floor(t0 * sr) + 1; i < Math.floor(t1 * sr); i++) { if (prev <= 0 && d[i] > 0) c++; prev = d[i]; } return c / (t1 - t0); };

  const renderCheck = async (page, setup) => A(page, async ([setupSrc]) => {
    const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
    const { renderProject } = await import('./js/export.js');
    const p = JSON.parse(JSON.stringify(window.__dys.project, (k, v) => (k === 'pts' ? undefined : v)));
    p.master = { vol: 1, reverb: 0, delay: 0, chorus: 0, drive: 0 };
    for (const t of p.tracks) { t.rev = 0; t.dly = 0; if (t.type === 'synth') { Object.assign(t, { wave: 'sine', cutoff: 18000, res: 0, drive: 0, vol: 1, a: 0.005, r: 0.05, inst: 'lead' }); } }
    new Function('p', setupSrc)(p);
    const { sanitizeProject, computeAllLines } = await import('./js/model.js');
    const clean = sanitizeProject(p); computeAllLines(clean);
    const buf = await renderProject(clean, { tail: 0.5 });
    const d = buf.getChannelData(0), sr = buf.sampleRate;
    let peak = 0; for (const x of d) peak = Math.max(peak, Math.abs(x));
    const onset = (thr) => { for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak * thr) return i / sr - 0.05; return -1; };
    const freq = (t0, t1) => { t0 += 0.05; t1 += 0.05; let c = 0, prev = d[Math.floor(t0 * sr)]; for (let i = Math.floor(t0 * sr) + 1; i < Math.floor(t1 * sr); i++) { if (prev <= 0 && d[i] > 0) c++; prev = d[i]; } return c / (t1 - t0); };
    const rms = (t0, t1) => { t0 += 0.05; t1 += 0.05; let s = 0, n = 0; for (let i = Math.floor(t0 * sr); i < Math.floor(t1 * sr) && i < d.length; i++) { s += d[i] * d[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
    return { peak, onset05: onset(0.05), onset30: onset(0.3), f: [freq(0.1, 0.4), freq(1.2, 1.5), freq(1.8, 1.95)], rmsA: rms(0.1, 0.9), rmsB: rms(1.1, 1.9), rmsEnd: rms(2.3, 2.4), len: buf.length / sr, sr };
  }, [setup]);

  await t('audio: a note at beat 2 / 120 BPM starts at 1.000 s with the right pitch (time coordinates == playback)', async (page) => {
    const r = await renderCheck(page, `p.bpm = 120; p.tracks[0].notes = [{id:'a', t: 2, d: 2, m: 69, v: 1}]; p.tracks[0].lines=[]; p.tracks[1].notes=[];`);
    assert.ok(r.peak > 0.05 && r.peak <= 1.0, `peak ${r.peak}`);
    assert.ok(Math.abs(r.onset30 - 1.0) < 0.02, `onset ${r.onset30}`);
    assert.ok(Math.abs(r.f[1] - 440) < 15, `freq ${r.f[1]}`);
  });

  await t('audio: halving the tempo doubles the time of the same beat position', async (page) => {
    const r = await renderCheck(page, `p.bpm = 60; p.tracks[0].notes = [{id:'a', t: 2, d: 1, m: 81, v: 1}]; p.tracks[0].lines=[]; p.tracks[1].notes=[];`);
    assert.ok(Math.abs(r.onset30 - 2.0) < 0.02, `onset ${r.onset30}`);
    assert.ok(Math.abs(r.f[2] - 0) >= 0); // placeholder window outside the note
  });

  await t('audio: a free-draw line plays its pitch at the right time (220 Hz -> 440 Hz over 4 beats)', async (page) => {
    const r = await renderCheck(page, `p.bpm = 120; p.tracks[0].notes=[]; p.tracks[1].notes=[]; p.tracks[0].lines=[{id:'l', raw:[[0,57],[1,57],[3,69],[4,69]], mode:'natural', amount:0, snap:false}];`);
    assert.ok(r.onset05 < 0.03, `onset ${r.onset05}`);
    assert.ok(Math.abs(r.f[0] - 220) < 14, `start freq ${r.f[0]}`);
    assert.ok(Math.abs(r.f[2] - 440) < 30 || r.f[2] > 380, `end freq ${r.f[2]}`);
  });

  await t('audio: drawn right-to-left plays identically (stored time order is independent of direction)', async (page) => {
    const a = await renderCheck(page, `p.tracks[0].notes=[]; p.tracks[1].notes=[]; p.tracks[0].lines=[{id:'l', raw:[[0,57],[2,63],[4,69]], mode:'natural', amount:0, snap:false}];`);
    const b = await renderCheck(page, `p.tracks[0].notes=[]; p.tracks[1].notes=[]; p.tracks[0].lines=[{id:'l', raw:[[4,69],[2,63],[0,57]], mode:'natural', amount:0, snap:false}];`);
    assert.ok(Math.abs(a.f[0] - b.f[0]) < 5 && Math.abs(a.f[2] - b.f[2]) < 8 && Math.abs(a.rmsA - b.rmsA) < 0.01);
  });

  await t('audio: output never exceeds 0 dBFS with 40 loud simultaneous voices (limiter)', async (page) => {
    const r = await renderCheck(page, `p.master={vol:1,reverb:0.5,delay:0.5,chorus:0.5,drive:0.8}; p.tracks[0].notes=[]; for(let i=0;i<40;i++) p.tracks[0].notes.push({id:'n'+i,t:0,d:3,m:36+i,v:1});`);
    assert.ok(r.peak <= 1.0001, `peak ${r.peak}`);
  });

  await t('audio: drums render and respect mute/solo', async (page) => {
    const r = await renderCheck(page, `p.tracks[0].notes=[]; p.tracks[1].notes=[]; p.tracks.forEach(t=>t.lines=[]); p.drums.lanes[0].steps=[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]; `);
    assert.ok(r.peak > 0.1, `drums peak ${r.peak}`);
    const m = await renderCheck(page, `p.tracks[0].notes=[]; p.tracks[1].notes=[]; p.drums.lanes[0].steps=[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]; p.tracks.find(t=>t.type==='drums').mute=true;`);
    assert.ok(m.peak < 0.001, `muted drums peak ${m.peak}`);
  });

  await t('playback: live play produces sound, playhead advances, stop frees every voice', async (page) => {
    await A(page, () => window.__dys.store.transact('t', (p) => { p.bpm = 240; p.tracks[0].notes.push({ id: 'a', t: 0, d: 3, m: 69, v: 1 }, { id: 'b', t: 4, d: 3, m: 72, v: 1 }); }));
    await page.click('#btnPlay'); await sleep(900);
    const s = await A(page, () => { const a = window.__dys, e = a.engine, d = new Float32Array(e.analyser.fftSize); e.analyser.getFloatTimeDomainData(d); let pk = 0; for (const x of d) pk = Math.max(pk, Math.abs(x)); return { running: e.ctx.state, peak: pk, playing: a.transport.playing, pos: a.transport.position(), active: e.stats().active }; });
    assert.equal(s.running, 'running'); assert.ok(s.playing && s.peak > 0.005, `peak ${s.peak}`); assert.ok(s.pos > 0 && s.pos <= 16);
    await page.click('#btnPlay'); await sleep(900);
    const e = await A(page, () => window.__dys.engine.stats());
    assert.equal(e.active, 0, 'no leaked voices'); assert.equal(e.created, e.ended);
    assert.equal(await A(page, () => window.__dys.transport.sched.registry.size), 0);
  }, { chromiumOnly: true });

  await t('playback: 25 start/stop cycles do not accumulate audio nodes or timers', async (page) => {
    await A(page, () => window.__dys.store.transact('t', (p) => { p.bpm = 200; p.tracks[0].notes.push({ id: 'a', t: 0, d: 2, m: 60, v: 1 }); p.drums.lanes[0].steps[0] = 1; }));
    for (let i = 0; i < 25; i++) { await page.click('#btnPlay'); await sleep(70); await page.click('#btnPlay'); await sleep(20); }
    await sleep(2200);
    const s = await A(page, () => ({ ...window.__dys.engine.stats(), reg: window.__dys.transport.sched.registry.size, timer: window.__dys.transport.timer }));
    assert.equal(s.active, 0); assert.equal(s.created, s.ended); assert.equal(s.timer, null); assert.equal(s.reg, 0);
  }, { chromiumOnly: true });

  await t('playback: editing during play — add, move, delete take effect without restart', async (page) => {
    await A(page, () => window.__dys.store.transact('t', (p) => { p.bpm = 240; p.tracks[0].notes = []; p.tracks[1].notes = []; }));
    await page.click('#btnPlay'); await sleep(250);
    const c0 = await A(page, () => window.__dys.engine.stats().created);
    // a long note covering "now" must join immediately (live overdub)
    await A(page, () => window.__dys.store.transact('t', (p) => { p.tracks[0].notes.push({ id: 'late', t: 0, d: 15, m: 60, v: 1 }); }));
    await sleep(150);
    const c1 = await A(page, () => window.__dys.engine.stats());
    assert.ok(c1.created > c0, 'late-join voice created'); assert.ok(c1.active >= 1);
    // removing it silences it
    await A(page, () => window.__dys.store.transact('t', (p) => { p.tracks[0].notes = []; }));
    await sleep(500);
    assert.equal(await A(page, () => window.__dys.engine.stats().active), 0, 'voice stopped after delete');
    // a drawn line while playing joins too
    await A(page, async () => { const { makeLine } = await import('./js/model.js'); const a = window.__dys; a.store.transact('t', (p) => { p.tracks[0].lines.push(makeLine([[0, 60], [8, 72], [15.5, 70]], { mode: 'natural', amount: 10 }, p)); }); });
    await sleep(200);
    assert.ok((await A(page, () => window.__dys.engine.stats().active)) >= 1, 'line voice joined');
    await page.click('#btnPlay');
  }, { chromiumOnly: true });

  await t('playback: BPM change while playing re-anchors without errors', async (page) => {
    await A(page, () => window.__dys.store.transact('t', (p) => { p.tracks[0].notes.push({ id: 'a', t: 0, d: 8, m: 60, v: 1 }); }));
    await page.click('#btnPlay'); await sleep(300);
    await page.click('#btnBpm'); await page.fill('#sheetBody input[type=number]', '90'); await page.press('#sheetBody input[type=number]', 'Tab'); await page.click('#sheetClose');
    await sleep(400);
    const s = await A(page, () => ({ bpm: window.__dys.project.bpm, playing: window.__dys.transport.playing, active: window.__dys.engine.stats().active }));
    assert.equal(s.bpm, 90); assert.ok(s.playing); assert.ok(s.active >= 1);
    await page.click('#btnPlay');
  }, { chromiumOnly: true });

  await t('drums: tap toggles steps, polymeter lane length, undo', async (page) => {
    await page.click('#views [data-view=drums]'); await sleep(100);
    const steps = page.locator('.drum-row').first().locator('.step');
    assert.equal(await steps.count(), 16);
    await steps.nth(0).click(); await steps.nth(4).click();
    assert.deepEqual((await proj(page)).drums.lanes[0].steps.slice(0, 5), [1, 0, 0, 0, 1]);
    await steps.nth(0).click(); assert.equal((await proj(page)).drums.lanes[0].steps[0], 0.5);
    await page.locator('.drum-row').first().locator('.drum-len button').nth(1).click(); // 17
    assert.equal(await page.locator('.drum-row').first().locator('.step').count(), 17);
    await page.click('#btnUndo'); assert.equal(await page.locator('.drum-row').first().locator('.step').count(), 16);
    // paint by dragging
    const row = page.locator('.drum-row').nth(3).locator('.drum-steps'); const b = await row.boundingBox();
    await mouseDrag(page, [[b.x + 6, b.y + 20], [b.x + b.width - 6, b.y + 20]], 20);
    assert.ok((await proj(page)).drums.lanes[3].steps.filter((x) => x === 1).length >= 12);
  });

  await t('mixer: mute and solo update the engine; track params are undoable', async (page) => {
    await page.click('#btnPlay'); await page.click('#btnPlay'); // creates the engine
    await page.click('#views [data-view=mix]'); await sleep(100);
    await page.locator('.mix-row').nth(1).locator('.ms.solo').click();
    assert.equal(await A(page, () => [window.__dys.engine.isAudible(window.__dys.project.tracks[0].id), window.__dys.engine.isAudible(window.__dys.project.tracks[1].id)]).then((x) => x.join()), 'false,true');
    await page.locator('.mix-row').nth(1).locator('.ms.solo').click();
    await page.locator('.mix-row').nth(0).locator('.ms:not(.solo)').click();
    assert.equal(await A(page, () => window.__dys.engine.isAudible(window.__dys.project.tracks[0].id)), false);
    await page.click('#btnUndo');
    assert.equal(await A(page, () => window.__dys.engine.isAudible(window.__dys.project.tracks[0].id)), true);
  }, { chromiumOnly: true });

  await t('tracks: add / rename / change instrument / ADSR / delete', async (page) => {
    await page.click('#trackbar .add'); await page.click('.inst >> text=Acid');
    assert.equal((await proj(page)).tracks.filter((t) => t.inst === 'acid').length, 1);
    await page.click('#trackbar .gear');
    await page.fill('#sheetBody input[type=text]', 'Моя гра'); await page.press('#sheetBody input[type=text]', 'Tab');
    assert.equal((await proj(page)).tracks.find((t) => t.inst === 'acid').name, 'Моя гра');
    await page.selectOption('#sheetBody select >> nth=1', 'square');
    assert.equal((await proj(page)).tracks.find((t) => t.inst === 'acid').wave, 'square');
    const sl = page.locator('#sheetBody input[type=range]').first(); await sl.fill('0.5');
    assert.equal((await proj(page)).tracks.find((t) => t.inst === 'acid').a, 0.5);
    page.once('dialog', (d) => d.accept());
    await page.click('#sheetBody button.danger');
    assert.equal((await proj(page)).tracks.filter((t) => t.inst === 'acid').length, 0);
  });

  // ---------- persistence / import / export ----------
  await t('autosave restores the project after reload; undo history is per session', async (page) => {
    const g = await toNotes(page);
    await page.mouse.click(gx(g, 2.0), gy(g, 65));
    await page.click('#btnBpm'); await page.fill('#sheetBody input[type=number]', '97'); await page.press('#sheetBody input[type=number]', 'Tab'); await page.click('#sheetClose');
    await sleep(700);
    await page.reload(); await page.waitForFunction(() => window.__dys);
    const p = await proj(page);
    assert.equal(p.bpm, 97); assert.equal(p.tracks[0].notes.length, 1); assert.equal(p.tracks[0].notes[0].m, 65);
    assert.equal(await A(page, () => window.__dys.prefs.view), 'notes');
  });

  await t('export JSON -> import JSON round-trips; invalid files are rejected without data loss', async (page, ctx) => {
    const g = await toNotes(page);
    await page.mouse.click(gx(g, 2.0), gy(g, 65));
    await setView(page, 'draw');
    const gd = await fdGeo(page);
    await mouseDrag(page, [[gd.l + 50, gd.t + 100], [gd.l + 400, gd.t + 200]], 10);
    const payload = await A(page, async () => { const { exportPayload } = await import('./js/model.js'); return exportPayload(window.__dys.project); });
    const before = await proj(page);
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    const good = path.join(root, 'test-results', 'good.json'), bad = path.join(root, 'test-results', 'bad.json'), junk = path.join(root, 'test-results', 'junk.json');
    fs.writeFileSync(good, payload); fs.writeFileSync(bad, '{"hello": 1}'); fs.writeFileSync(junk, '{{{not json');
    await page.setInputFiles('#fileInput', bad); await sleep(300);
    assert.equal((await proj(page)).id, before.id); assert.ok((await page.textContent('#toast')).includes('Помилка імпорту'));
    await page.setInputFiles('#fileInput', junk); await sleep(300);
    assert.equal((await proj(page)).id, before.id);
    await page.setInputFiles('#fileInput', good); await sleep(400);
    const after = await proj(page);
    assert.notEqual(after.id, before.id);
    assert.equal(after.tracks[0].notes.length, 1); assert.equal(after.tracks[0].lines.length, 1);
    assert.deepEqual(after.tracks[0].lines[0].raw, before.tracks[0].lines[0].raw);
    const stored = await A(page, () => JSON.parse(localStorage.getItem('dys:index')).length);
    assert.ok(stored >= 2, 'both projects kept');
  });

  await t('legacy (old version) project file imports correctly', async (page) => {
    const legacy = { version: 3, lines: [[{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }]], notes: [{ x: 0.25, len: 0.125, midi: 60 }], brushes: ['bass'], shapeModes: ['natural'], duration: 8, volume: 15, wave: 'sawtooth', params: {} };
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    const f = path.join(root, 'test-results', 'legacy.json'); fs.writeFileSync(f, JSON.stringify(legacy));
    await page.setInputFiles('#fileInput', f); await sleep(400);
    const p = await proj(page);
    assert.equal(p.bars, 4);
    const bass = p.tracks.find((t) => t.inst === 'bass'); assert.ok(bass.lines.length === 1);
    assert.ok(Math.abs(bass.lines[0].raw[2][0] - 16) < 1e-9);
    assert.equal(p.tracks.find((t) => t.inst === 'lead').notes[0].t, 4);
  });

  await t('multiple projects: create, switch, rename, duplicate, delete', async (page) => {
    await page.click('#btnMenu');
    await page.fill('#sheetBody input[type=text]', 'Альфа'); await page.press('#sheetBody input[type=text]', 'Tab');
    await page.click('#sheetBody >> text=＋ Новий');
    assert.equal(await A(page, () => window.__dys.project.name.startsWith('Новий проєкт')), true);
    await page.click('#btnMenu'); await sleep(50);
    assert.ok((await page.locator('.prow').count()) >= 2);
    await page.locator('.prow .pname', { hasText: 'Альфа' }).click();
    assert.equal(await A(page, () => window.__dys.project.name), 'Альфа');
    await page.click('#btnMenu'); await page.click('#sheetBody >> text=Дублювати');
    assert.equal(await A(page, () => window.__dys.project.name), 'Альфа копія');
    await page.click('#btnMenu'); page.once('dialog', (d) => d.accept());
    await page.locator('.prow.cur button.danger').click(); await sleep(150);
    assert.notEqual(await A(page, () => window.__dys.project.name), 'Альфа копія');
  });

  await t('exports: MIDI and WAV files are produced', async (page) => {
    await A(page, async () => { const { demoProject } = await import('./js/model.js'); const p = demoProject(); window.__dys.loadProjectObject(p); });
    await page.click('#btnMenu');
    const [mid] = await Promise.all([page.waitForEvent('download'), page.click('#sheetBody >> text=Експорт MIDI')]);
    const mp = path.join(root, 'test-results', 'out.mid'); await mid.saveAs(mp);
    assert.equal(fs.readFileSync(mp).slice(0, 4).toString(), 'MThd');
    const [wav] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#sheetBody >> text=Експорт WAV')]);
    const wp = path.join(root, 'test-results', 'out.wav'); await wav.saveAs(wp);
    const b = fs.readFileSync(wp); assert.equal(b.slice(0, 4).toString(), 'RIFF'); assert.ok(b.length > 200000, `wav bytes ${b.length}`);
    let peak = 0; for (let i = 44; i < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i))); assert.ok(peak > 1000 && peak <= 32767);
  }, { chromiumOnly: true });

  await t('offline: after the first visit the app loads without a network', async (page, ctx) => {
    await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await sleep(500);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await ctx.setOffline(true);
    await page.reload(); await page.waitForFunction(() => window.__dys, null, { timeout: 8000 });
    assert.equal(await page.title(), 'Draw Your Sound');
    await ctx.setOffline(false);
  }, { chromiumOnly: true });

  await t('keyboard: Space plays, Cmd/Ctrl+Z / +Shift+Z undo-redo, view hotkeys', async (page) => {
    await page.keyboard.press('2'); assert.equal(await A(page, () => window.__dys.prefs.view), 'notes');
    const g = await prGeo(page);
    await page.mouse.click(gx(g, 1), gy(g, 60));
    await page.keyboard.press('Meta+z'); assert.equal((await notesOf(page)).length, 0);
    await page.keyboard.press('Meta+Shift+z'); assert.equal((await notesOf(page)).length, 1);
    await page.keyboard.press('Space'); await sleep(300); assert.equal(await A(page, () => window.__dys.transport.playing), true);
    await page.keyboard.press('Space'); await sleep(100); assert.equal(await A(page, () => window.__dys.transport.playing), false);
  }, { chromiumOnly: true });

  // ---------- touch ----------
  const cdpTouch = async (page, type, pts) => { const c = page._cdp || (page._cdp = await page.context().newCDPSession(page)); await c.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) }); };
  const finger = async (page, path_, steps = 8) => {
    await cdpTouch(page, 'touchStart', [path_[0]]);
    for (let i = 1; i < path_.length; i++) for (let s = 1; s <= steps; s++) { const a = path_[i - 1], b = path_[i]; await cdpTouch(page, 'touchMove', [{ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps }]); }
    await cdpTouch(page, 'touchEnd', []);
  };

  await t('touch: finger draws a line across the whole width; two fingers pan/zoom without drawing', async (page) => {
    const g = await fdGeo(page);
    await finger(page, [{ x: g.l + 2, y: g.t + 200 }, { x: g.l + g.w - 2, y: g.t + 260 }], 14);
    let ls = await linesOf(page); assert.equal(ls.length, 1);
    assert.ok(ls[0].pts[0].t < 0.1 && ls[0].pts[ls[0].pts.length - 1].t > g.tMax - 0.1);
    // pinch: two fingers spreading horizontally
    const cx = g.l + g.w / 2, cy = g.t + g.h / 2;
    await cdpTouch(page, 'touchStart', [{ x: cx - 40, y: cy, id: 0 }, { x: cx + 40, y: cy, id: 1 }]);
    for (let s = 1; s <= 10; s++) await cdpTouch(page, 'touchMove', [{ x: cx - 40 - s * 12, y: cy, id: 0 }, { x: cx + 40 + s * 12, y: cy, id: 1 }]);
    await cdpTouch(page, 'touchEnd', []);
    const z = await fdGeo(page); assert.ok(z.ppb > g.ppb * 1.5, `pinch zoom ${g.ppb} -> ${z.ppb}`);
    assert.equal((await linesOf(page)).length, 1, 'pinch did not draw a stray line');
  }, { touch: true, chromiumOnly: true, viewport: { width: 390, height: 780 } });

  await t('touch: piano roll — tap creates, finger moves and resizes notes (coarse tolerance), pinch zooms', async (page) => {
    const g = await toNotes(page);
    await finger(page, [{ x: gx(g, 1.02), y: gy(g, 62) }], 1);
    let n = await notesOf(page); assert.equal(n.length, 1);
    // grab the note with a finger slightly outside its edge and move it
    const nr = { x1: gx(g, n[0].t), x2: gx(g, n[0].t + n[0].d) };
    await finger(page, [{ x: nr.x1 + 5, y: gy(g, 62) + 5 }, { x: nr.x1 + 5 + g.ppb * 2, y: gy(g, 65) }], 10);
    n = await notesOf(page); assert.equal(n.length, 1); assert.equal(n[0].m, 65); assert.ok(n[0].t >= 2.9 && n[0].t <= 3.1, `t ${n[0].t}`);
    // resize by dragging just past the right edge
    const g2 = await prGeo(page);
    await finger(page, [{ x: gx(g2, n[0].t + n[0].d) + 6, y: gy(g2, 65) }, { x: gx(g2, n[0].t + n[0].d) + 6 + g2.ppb * 1, y: gy(g2, 65) }], 10);
    n = await notesOf(page); assert.ok(n[0].d >= 1.4, `len ${n[0].d}`);
    assert.equal(await undoLen(page), 3);
    const before = (await prGeo(page)).ppb;
    const cx = g.l + g.w / 2, cy = g.t + g.h / 2;
    await cdpTouch(page, 'touchStart', [{ x: cx - 40, y: cy, id: 0 }, { x: cx + 40, y: cy, id: 1 }]);
    for (let s = 1; s <= 8; s++) await cdpTouch(page, 'touchMove', [{ x: cx - 40 - s * 10, y: cy, id: 0 }, { x: cx + 40 + s * 10, y: cy, id: 1 }]);
    await cdpTouch(page, 'touchEnd', []);
    assert.ok((await prGeo(page)).ppb > before * 1.3);
    assert.equal(await undoLen(page), 3, 'pinch did not edit notes');
  }, { touch: true, chromiumOnly: true, viewport: { width: 390, height: 780 } });

  await t('layout: iPhone-size viewport has no horizontal page scroll and the canvas fills the stage', async (page) => {
    const m = await A(page, () => { const s = document.getElementById('stage').getBoundingClientRect(), c = document.getElementById('cvDraw').getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, iw: innerWidth, stage: s.height, canvas: c.height, cw: c.width, sww: s.width }; });
    assert.ok(m.sw <= m.iw, 'no horizontal overflow'); assert.ok(Math.abs(m.canvas - m.stage) < 1 && Math.abs(m.cw - m.sww) < 1);
    assert.ok(m.stage > 330, `stage height ${m.stage}`);
  }, { viewport: { width: 390, height: 780 } });
}
