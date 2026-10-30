import { uid } from '../core/canvas';
import type { Doc } from '../core/doc';
import type { Cuts, Rect, Slice } from '../core/types';
import { app } from '../store';
import { changed, infoLabel, requestRender, snapPoint, type PointerInfo, type Tool } from './base';

type Axis = 'x' | 'y';

/** Прямоугольники кусков между линиями раскроя (построчно, слева направо). */
export function cutPieces(doc: Doc): Rect[] {
  const xs = [0, ...doc.cuts.x, doc.width];
  const ys = [0, ...doc.cuts.y, doc.height];
  const out: Rect[] = [];
  for (let r = 0; r < ys.length - 1; r++)
    for (let c = 0; c < xs.length - 1; c++) out.push({ x: xs[c], y: ys[r], w: xs[c + 1] - xs[c], h: ys[r + 1] - ys[r] });
  return out;
}

export function piecesAsSlices(doc: Doc, prefix: string): Slice[] {
  const cols = doc.cuts.x.length + 1;
  return cutPieces(doc).map((r, i) => ({
    id: uid('sl'),
    name: `${prefix}${Math.floor(i / cols)}_${i % cols}`,
    ...r,
    nine: null,
  }));
}

function axisFor(p: PointerInfo): Axis {
  const vertical = app().opts.knifeDir === 'vertical';
  // Shift меняет направление реза на противоположное
  return vertical !== p.shift ? 'x' : 'y';
}

/** Линия реза под курсором (в пределах 5 экранных пикселей). */
function hitCut(doc: Doc, p: PointerInfo): { axis: Axis; index: number } | null {
  const tol = 5 / doc.view.zoom;
  let best: { axis: Axis; index: number; d: number } | null = null;
  for (const axis of ['x', 'y'] as Axis[]) {
    doc.cuts[axis].forEach((v, index) => {
      const d = Math.abs((axis === 'x' ? p.x : p.y) - v);
      if (d <= tol && (!best || d < best.d)) best = { axis, index, d };
    });
  }
  return best;
}

let drag: { axis: Axis; index: number; orig: Cuts; value: number } | null = null;
let hover: { axis: Axis; value: number; existing: boolean } | null = null;

const inside = (doc: Doc, p: PointerInfo) => p.x >= 0 && p.y >= 0 && p.x <= doc.width && p.y <= doc.height;

export const knifeTool: Tool = {
  cursor(p, doc) {
    if (!p) return 'crosshair';
    const h = hitCut(doc, p);
    if (h) return h.axis === 'x' ? 'col-resize' : 'row-resize';
    return axisFor(p) === 'x' ? 'col-resize' : 'row-resize';
  },
  down(p, doc) {
    const hit = hitCut(doc, p);
    if (hit && p.alt) {
      const cuts = { ...doc.cuts, [hit.axis]: doc.cuts[hit.axis].filter((_, i) => i !== hit.index) };
      doc.setCuts(cuts, 'Удалить рез');
      return changed();
    }
    if (hit) {
      drag = { ...hit, orig: doc.cuts, value: doc.cuts[hit.axis][hit.index] };
      return;
    }
    if (!inside(doc, p)) return;
    const axis = axisFor(p);
    const v = snapPoint(p, doc.view)[axis];
    if (v <= 0 || v >= (axis === 'x' ? doc.width : doc.height)) return;
    doc.setCuts({ ...doc.cuts, [axis]: [...doc.cuts[axis], v] }, axis === 'x' ? 'Вертикальный рез' : 'Горизонтальный рез');
    changed();
  },
  drag(p, doc) {
    if (!drag) return;
    drag.value = snapPoint(p, doc.view)[drag.axis];
    // во время перетаскивания линия показывается без записи в историю
    const list = [...drag.orig[drag.axis]];
    list[drag.index] = drag.value;
    doc.cuts = { ...drag.orig, [drag.axis]: list };
    requestRender();
  },
  up(p, doc) {
    if (!drag) return;
    const d = drag;
    drag = null;
    doc.cuts = d.orig;
    const max = d.axis === 'x' ? doc.width : doc.height;
    const list = [...d.orig[d.axis]];
    // утащили за пределы холста — рез удаляется
    if (!inside(doc, p) || d.value <= 0 || d.value >= max) list.splice(d.index, 1);
    else list[d.index] = d.value;
    if (list.join() !== d.orig[d.axis].join()) doc.setCuts({ ...d.orig, [d.axis]: list }, 'Переместить рез');
    changed();
  },
  hover(p, doc) {
    const hit = hitCut(doc, p);
    if (hit) hover = { axis: hit.axis, value: doc.cuts[hit.axis][hit.index], existing: true };
    else if (inside(doc, p)) {
      const axis = axisFor(p);
      hover = { axis, value: snapPoint(p, doc.view)[axis], existing: false };
    } else hover = null;
    requestRender();
  },
  key(e, doc) {
    if (e.key === 'Escape' && (doc.cuts.x.length || doc.cuts.y.length)) {
      doc.setCuts({ x: [], y: [] }, 'Очистить резы');
      changed();
      return true;
    }
    return false;
  },
  deactivate(doc) {
    if (drag && doc) doc.cuts = drag.orig;
    drag = null;
    hover = null;
  },
  overlay(ctx, v, doc) {
    const h = drag ? { axis: drag.axis, value: drag.value, existing: true } : hover;
    if (h && !h.existing) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,59,107,0.7)';
      ctx.beginPath();
      if (h.axis === 'x') {
        const sx = Math.round(v.panX + h.value * v.zoom) + 0.5;
        ctx.moveTo(sx, v.panY);
        ctx.lineTo(sx, v.panY + doc.height * v.zoom);
      } else {
        const sy = Math.round(v.panY + h.value * v.zoom) + 0.5;
        ctx.moveTo(v.panX, sy);
        ctx.lineTo(v.panX + doc.width * v.zoom, sy);
      }
      ctx.stroke();
      ctx.restore();
    }
    const pieces = (doc.cuts.x.length + 1) * (doc.cuts.y.length + 1);
    const label = `${h ? `${h.axis === 'x' ? 'X' : 'Y'} = ${h.value}   ` : ''}кусков: ${pieces}`;
    infoLabel(ctx, label, 12, 12);
  },
};
