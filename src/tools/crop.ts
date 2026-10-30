import { create } from 'zustand';
import { createCanvas, ctx2d, intersectRect, normRect } from '../core/canvas';
import type { Doc } from '../core/doc';
import { drawHandles, hitHandle, HANDLE_CURSORS, rectToScreen, resizeByHandle } from '../core/render';
import type { Point, Rect } from '../core/types';
import { changed, infoLabel, requestRender, snapPoint, type Tool } from './base';

/** Текущая рамка кадрирования — её показывает панель опций. */
export const useCrop = create<{ rect: Rect | null }>(() => ({ rect: null }));

type Drag = { kind: 'new'; start: Point } | { kind: 'move'; start: Point; orig: Rect } | { kind: 'handle'; i: number; orig: Rect };
let drag: Drag | null = null;

const setRect = (r: Rect | null) => {
  useCrop.setState({ rect: r });
  requestRender();
};

export function applyCrop(doc: Doc, r: Rect) {
  const rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  if (rect.w < 1 || rect.h < 1) return;
  doc.transformAll(
    'Кадрирование',
    rect.w,
    rect.h,
    (c) => {
      const out = createCanvas(rect.w, rect.h);
      ctx2d(out).drawImage(c, -rect.x, -rect.y);
      return out;
    },
    (s) => {
      const moved = { x: s.x - rect.x, y: s.y - rect.y, w: s.w, h: s.h };
      const clipped = intersectRect(moved, { x: 0, y: 0, w: rect.w, h: rect.h });
      return clipped ? { ...s, ...clipped } : null;
    },
  );
  doc.needsFit = true;
  setRect(null);
  changed();
}

export const cropTool: Tool = {
  cursor(p, doc) {
    const r = useCrop.getState().rect;
    if (!r || !p) return 'crosshair';
    const h = hitHandle(rectToScreen(doc.view, r), p.sx, p.sy);
    if (h >= 0) return HANDLE_CURSORS[h];
    if (p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h) return 'move';
    return 'crosshair';
  },
  down(p, doc) {
    const r = useCrop.getState().rect;
    if (r) {
      const h = hitHandle(rectToScreen(doc.view, r), p.sx, p.sy);
      if (h >= 0) return void (drag = { kind: 'handle', i: h, orig: r });
      if (p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h) return void (drag = { kind: 'move', start: { x: p.x, y: p.y }, orig: r });
    }
    drag = { kind: 'new', start: snapPoint(p, doc.view) };
    setRect(null);
  },
  drag(p, doc) {
    if (!drag) return;
    const sp = snapPoint(p, doc.view);
    if (drag.kind === 'new') {
      let w = sp.x - drag.start.x, h = sp.y - drag.start.y;
      if (p.shift) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      setRect(normRect(drag.start.x, drag.start.y, drag.start.x + w, drag.start.y + h));
    } else if (drag.kind === 'move') {
      setRect({ ...drag.orig, x: Math.round(drag.orig.x + p.x - drag.start.x), y: Math.round(drag.orig.y + p.y - drag.start.y) });
    } else setRect(resizeByHandle(drag.orig, drag.i, sp));
  },
  up() {
    drag = null;
    const r = useCrop.getState().rect;
    if (r && (r.w < 1 || r.h < 1)) setRect(null);
  },
  dblclick(_p, doc) {
    const r = useCrop.getState().rect;
    if (r) applyCrop(doc, r);
  },
  key(e, doc) {
    const r = useCrop.getState().rect;
    if (!r) return false;
    if (e.key === 'Enter') applyCrop(doc, r);
    else if (e.key === 'Escape') setRect(null);
    else return false;
    return true;
  },
  deactivate() {
    drag = null;
    setRect(null);
  },
  overlay(ctx, v, doc) {
    const r = useCrop.getState().rect;
    if (!r) return;
    const s = rectToScreen(v, r);
    const W = ctx.canvas.width / v.dpr, H = ctx.canvas.height / v.dpr;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(s.x, s.y, s.w, s.h);
    ctx.fill('evenodd');
    // правило третей
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    for (const k of [1 / 3, 2 / 3]) {
      ctx.moveTo(s.x + s.w * k, s.y);
      ctx.lineTo(s.x + s.w * k, s.y + s.h);
      ctx.moveTo(s.x, s.y + s.h * k);
      ctx.lineTo(s.x + s.w, s.y + s.h * k);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(Math.round(s.x) + 0.5, Math.round(s.y) + 0.5, Math.round(s.w), Math.round(s.h));
    ctx.restore();
    drawHandles(ctx, s);
    infoLabel(ctx, `${Math.round(r.w)} × ${Math.round(r.h)}${r.x < 0 || r.y < 0 || r.x + r.w > doc.width || r.y + r.h > doc.height ? ' (расширение холста)' : ''}`, s.x, s.y + s.h + 8);
  },
};
