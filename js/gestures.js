// Unified pointer handling for the canvas editors.
//  - one pointer  -> edit gesture (down/move/up)
//  - second touch -> the edit is cancelled and a pinch/pan gesture takes over
//  - mouse wheel / trackpad scroll / ctrl+wheel pinch / Safari gesture events -> navigation
// A finger that stays down after a pinch can never start a stray edit.

export function bindPointers(el, h) {
  const ptrs = new Map();
  let primary = null;
  let multi = null;
  let blocked = false;

  const pos = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button === 2) { e.preventDefault(); if (h.secondary) h.secondary(pos(e), e); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const p = pos(e);
    ptrs.set(e.pointerId, { ...p, type: e.pointerType });
    if (ptrs.size === 1) { blocked = false; primary = e.pointerId; h.down(p, e); }
    else if (ptrs.size === 2 && e.pointerType !== 'mouse') {
      if (primary !== null) { h.cancel && h.cancel(); primary = null; }
      blocked = true;
      const [a, b] = [...ptrs.values()];
      multi = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, sx: Math.abs(a.x - b.x), sy: Math.abs(a.y - b.y) };
    }
  });

  el.addEventListener('pointermove', (e) => {
    const p = pos(e);
    const rec = ptrs.get(e.pointerId);
    if (!rec) { if (e.pointerType === 'mouse' && h.hover) h.hover(p, e); return; }
    rec.x = p.x; rec.y = p.y;
    if (multi && ptrs.size >= 2) {
      e.preventDefault();
      const [a, b] = [...ptrs.values()];
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, sx = Math.abs(a.x - b.x), sy = Math.abs(a.y - b.y);
      const fx = multi.sx > 24 && sx > 24 ? sx / multi.sx : 1;
      const fy = multi.sy > 24 && sy > 24 ? sy / multi.sy : 1;
      h.pinch && h.pinch({ cx, cy, dx: cx - multi.cx, dy: cy - multi.cy, fx, fy });
      multi = { cx, cy, sx: sx > 24 ? sx : multi.sx, sy: sy > 24 ? sy : multi.sy };
      return;
    }
    if (e.pointerId === primary && !blocked) {
      e.preventDefault();
      let list = null;
      if (e.getCoalescedEvents) { const cs = e.getCoalescedEvents(); if (cs.length > 1) list = cs.map(pos); }
      h.move(p, e, list || [p]);
    }
  });

  const finish = (e, cancelled) => {
    const rec = ptrs.get(e.pointerId);
    if (!rec) return;
    ptrs.delete(e.pointerId);
    try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (e.pointerId === primary) {
      primary = null;
      if (!blocked) { if (cancelled) h.cancel && h.cancel(); else h.up(pos(e), e); }
    }
    if (ptrs.size < 2) multi = null;
    if (ptrs.size === 0) { blocked = false; primary = null; }
  };
  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
  el.addEventListener('lostpointercapture', (e) => { if (ptrs.has(e.pointerId) && e.pointerId === primary) finish(e, true); });

  el.addEventListener('wheel', (e) => { e.preventDefault(); h.wheel && h.wheel(pos(e), e); }, { passive: false });

  // Safari desktop trackpad pinch
  let lastScale = 1;
  el.addEventListener('gesturestart', (e) => { e.preventDefault(); lastScale = 1; });
  el.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const f = e.scale / lastScale; lastScale = e.scale;
    h.zoomGesture && h.zoomGesture(pos(e), f);
  });
  el.addEventListener('gestureend', (e) => e.preventDefault());

  return { active: () => ptrs.size };
}

// Standard wheel semantics shared by both editors.
export function wheelNavigate(vp, p, e, { allowY = true } = {}) {
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
  if (e.ctrlKey || e.metaKey) { vp.zoomX(Math.exp(-dy * 0.012), p.x); if (allowY && e.altKey) vp.zoomY(Math.exp(-dy * 0.012), p.y); return; }
  if (e.altKey && allowY) { vp.zoomY(Math.exp(-dy * 0.012), p.y); return; }
  if (e.shiftKey) vp.panBy(-(dy || dx), 0);
  else vp.panBy(-dx, -dy);
}
