import { normRect, uid } from '../core/canvas';
import type { Doc } from '../core/doc';
import { hitHandle, HANDLE_CURSORS, rectToScreen, resizeByHandle } from '../core/render';
import type { Point, Rect, Slice } from '../core/types';
import { changed, infoLabel, requestRender, snapPoint, type Tool } from './base';

type Drag =
  | { kind: 'new'; start: Point; orig: Slice[]; id: string }
  | { kind: 'move'; start: Point; orig: Slice[]; slice: Slice }
  | { kind: 'handle'; i: number; orig: Slice[]; slice: Slice };

let drag: Drag | null = null;
let live: Rect | null = null;

function sliceAt(doc: Doc, p: Point) {
  for (let i = doc.slices.length - 1; i >= 0; i--) {
    const s = doc.slices[i];
    if (p.x >= s.x && p.y >= s.y && p.x < s.x + s.w && p.y < s.y + s.h) return s;
  }
  return null;
}

const clampToDoc = (doc: Doc, r: Rect): Rect => {
  const x = Math.max(0, Math.min(doc.width - 1, r.x)), y = Math.max(0, Math.min(doc.height - 1, r.y));
  return { x, y, w: Math.max(1, Math.min(doc.width - x, r.w)), h: Math.max(1, Math.min(doc.height - y, r.h)) };
};

/**
 * Во время перетаскивания doc.slices подменяется новым массивом без записи в историю;
 * на отпускании исходный массив восстанавливается и итог записывается одной операцией.
 */
function preview(doc: Doc, orig: Slice[], id: string, r: Rect) {
  doc.slices = orig.map((s) => (s.id === id ? { ...s, ...r } : s));
  live = r;
  requestRender();
}

export const sliceTool: Tool = {
  cursor(p, doc) {
    if (!p) return 'crosshair';
    const a = doc.slices.find((s) => s.id === doc.activeSliceId);
    if (a) {
      const h = hitHandle(rectToScreen(doc.view, a), p.sx, p.sy);
      if (h >= 0) return HANDLE_CURSORS[h];
    }
    return sliceAt(doc, p) ? 'move' : 'crosshair';
  },
  down(p, doc) {
    const active = doc.slices.find((s) => s.id === doc.activeSliceId);
    if (active) {
      const h = hitHandle(rectToScreen(doc.view, active), p.sx, p.sy);
      if (h >= 0) return void (drag = { kind: 'handle', i: h, orig: doc.slices, slice: active });
    }
    const hit = p.alt ? null : sliceAt(doc, p);
    if (hit) {
      doc.activeSliceId = hit.id;
      drag = { kind: 'move', start: { x: p.x, y: p.y }, orig: doc.slices, slice: hit };
      return changed();
    }
    const id = uid('sl');
    const start = snapPoint(p, doc.view);
    drag = { kind: 'new', start, orig: doc.slices, id };
    doc.slices = [...doc.slices, { id, name: doc.nextSliceName(), x: start.x, y: start.y, w: 0, h: 0, nine: null }];
    doc.activeSliceId = id;
    changed();
  },
  drag(p, doc) {
    if (!drag) return;
    const sp = snapPoint(p, doc.view);
    if (drag.kind === 'new') {
      const r = normRect(drag.start.x, drag.start.y, sp.x, sp.y);
      const id = drag.id;
      doc.slices = doc.slices.map((s) => (s.id === id ? { ...s, ...r } : s));
      live = r;
      requestRender();
    } else if (drag.kind === 'move') {
      const s = drag.slice;
      const r = clampToDoc(doc, { x: Math.round(s.x + p.x - drag.start.x), y: Math.round(s.y + p.y - drag.start.y), w: s.w, h: s.h });
      r.x = Math.min(r.x, doc.width - s.w);
      r.y = Math.min(r.y, doc.height - s.h);
      r.w = s.w;
      r.h = s.h;
      preview(doc, drag.orig, s.id, r);
    } else preview(doc, drag.orig, drag.slice.id, resizeByHandle(drag.slice, drag.i, sp));
  },
  up(_p, doc) {
    if (!drag) return;
    const d = drag;
    drag = null;
    live = null;
    const finalSlices = doc.slices;
    doc.slices = d.orig;
    if (d.kind === 'new') {
      const s = finalSlices.find((x) => x.id === d.id)!;
      if (s.w < 2 || s.h < 2) {
        doc.activeSliceId = null;
        return changed();
      }
      doc.setSlices([...d.orig, { ...s, ...clampToDoc(doc, s) }], 'Новый слайс');
      doc.activeSliceId = s.id;
    } else {
      const s = finalSlices.find((x) => x.id === d.slice.id)!;
      if (s.x !== d.slice.x || s.y !== d.slice.y || s.w !== d.slice.w || s.h !== d.slice.h)
        doc.updateSlice(s.id, clampToDoc(doc, s), d.kind === 'move' ? 'Переместить слайс' : 'Изменить размер слайса');
    }
    changed();
  },
  key(e, doc) {
    const a = doc.slices.find((s) => s.id === doc.activeSliceId);
    if (!a) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      doc.setSlices(doc.slices.filter((s) => s.id !== a.id), 'Удалить слайс');
      doc.activeSliceId = null;
    } else if (e.key === 'Escape') doc.activeSliceId = null;
    else if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] ?? [0, 0];
      doc.updateSlice(a.id, clampToDoc(doc, { ...a, x: a.x + d[0] * step, y: a.y + d[1] * step }), 'Сдвиг слайса');
    } else return false;
    changed();
    return true;
  },
  deactivate(doc) {
    if (drag && doc) doc.slices = drag.orig;
    drag = null;
    live = null;
  },
  overlay(ctx, v) {
    if (!live) return;
    const s = rectToScreen(v, live);
    infoLabel(ctx, `${live.x}, ${live.y}  ${live.w} × ${live.h}`, s.x + s.w + 8, s.y + s.h + 8);
  },
};
