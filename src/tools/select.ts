import { createCanvas, ctx2d, normRect } from '../core/canvas';
import type { Doc } from '../core/doc';
import { floodMask } from '../core/flood';
import { compositeForView, toScreen } from '../core/render';
import { combineSelection, featherSelection, selectionFromMask, shapeMask, type ShapeSpec } from '../core/selection';
import type { Point, Rect, SelectMode } from '../core/types';
import { app } from '../store';
import { changed, dashedRect, infoLabel, requestRender, snapPoint, type PointerInfo, type Tool } from './base';

function modeFrom(p: PointerInfo): SelectMode {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return app().opts.selectMode;
}

const MODE_LABEL: Record<SelectMode, string> = {
  replace: 'Выделение',
  add: 'Добавить к выделению',
  subtract: 'Вычесть из выделения',
  intersect: 'Пересечение выделений',
};

function applyShape(doc: Doc, spec: ShapeSpec, mode: SelectMode) {
  const o = app().opts;
  const mask = shapeMask(doc.width, doc.height, spec, o.selectAntialias);
  let shape = selectionFromMask(mask);
  if (shape && o.feather > 0) shape = featherSelection(shape, o.feather);
  const next = combineSelection(mode === 'replace' ? null : doc.selection, shape ? shape.mask : createCanvas(doc.width, doc.height), mode);
  doc.setSelection(next, next ? MODE_LABEL[mode] : 'Снять выделение');
  changed();
}

/** Перемещение контура выделения (без пикселей) — перетаскивание внутри выделения. */
function insideSelection(doc: Doc, p: Point) {
  const s = doc.selection;
  if (!s) return false;
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < s.bounds.x || y < s.bounds.y || x >= s.bounds.x + s.bounds.w || y >= s.bounds.y + s.bounds.h) return false;
  return ctx2d(s.mask).getImageData(x, y, 1, 1).data[3] > 127;
}

interface MoveOutline {
  start: Point;
  dx: number;
  dy: number;
}

// ---------- прямоугольник / эллипс ----------

function makeMarquee(kind: 'rect' | 'ellipse'): Tool {
  let start: Point | null = null;
  let rect: Rect | null = null;
  let mode: SelectMode = 'replace';
  let moving: MoveOutline | null = null;

  const computeRect = (p: PointerInfo, doc: Doc): Rect => {
    const o = app().opts;
    const a = start!;
    const b = snapPoint(p, doc.view);
    let w = b.x - a.x, h = b.y - a.y;
    if (o.selectFixed === 'size') {
      return { x: Math.round(p.x - o.selectFixedW / 2), y: Math.round(p.y - o.selectFixedH / 2), w: o.selectFixedW, h: o.selectFixedH };
    }
    if (o.selectFixed === 'ratio' || (p.shift && mode === 'replace')) {
      const ratio = o.selectFixed === 'ratio' ? o.selectFixedW / Math.max(1, o.selectFixedH) : 1;
      const side = Math.max(Math.abs(w), Math.abs(h) * ratio);
      w = Math.sign(w || 1) * side;
      h = Math.sign(h || 1) * (side / ratio);
    }
    if (p.alt && mode === 'replace') return normRect(a.x - w, a.y - h, a.x + w, a.y + h);
    return normRect(a.x, a.y, a.x + w, a.y + h);
  };

  return {
    cursor: (p, doc) => (p && insideSelection(doc, p) && !p.shift && !p.alt ? 'move' : 'crosshair'),
    down(p, doc) {
      mode = modeFrom(p);
      if (mode === app().opts.selectMode && mode === 'replace' && insideSelection(doc, p) && app().opts.selectFixed !== 'size') {
        moving = { start: { x: p.x, y: p.y }, dx: 0, dy: 0 };
        return;
      }
      start = snapPoint(p, doc.view);
      rect = app().opts.selectFixed === 'size' ? computeRect(p, doc) : null;
      requestRender();
    },
    drag(p, doc) {
      if (moving) {
        moving.dx = Math.round(p.x - moving.start.x);
        moving.dy = Math.round(p.y - moving.start.y);
      } else if (start) rect = computeRect(p, doc);
      requestRender();
    },
    up(_p, doc) {
      if (moving) {
        const { dx, dy } = moving;
        moving = null;
        if ((dx || dy) && doc.selection) {
          const m = createCanvas(doc.width, doc.height);
          ctx2d(m).drawImage(doc.selection.mask, dx, dy);
          doc.setSelection(selectionFromMask(m), 'Переместить выделение');
        }
        return changed();
      }
      if (!start) return;
      const r = rect;
      start = null;
      rect = null;
      if (!r || r.w < 1 || r.h < 1) {
        if (mode === 'replace') doc.setSelection(null);
        return changed();
      }
      applyShape(doc, { kind, rect: r }, mode);
    },
    deactivate() {
      start = null;
      rect = null;
      moving = null;
    },
    hidesSelection: () => !!moving,
    overlay(ctx, v, doc) {
      if (moving && doc.selection) {
        ctx.save();
        ctx.translate(v.panX + moving.dx * v.zoom, v.panY + moving.dy * v.zoom);
        ctx.scale(v.zoom, v.zoom);
        ctx.lineWidth = 1 / v.zoom;
        ctx.setLineDash([4 / v.zoom, 4 / v.zoom]);
        ctx.strokeStyle = '#fff';
        ctx.stroke(doc.selection.outline);
        ctx.restore();
        return;
      }
      if (!rect) return;
      const s = toScreen(v, rect);
      const w = rect.w * v.zoom, h = rect.h * v.zoom;
      if (kind === 'rect') dashedRect(ctx, s.x, s.y, w, h);
      else {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(s.x + w / 2, s.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.restore();
      }
      infoLabel(ctx, `${rect.w} × ${rect.h}`, s.x + w + 8, s.y + h + 8);
    },
  };
}

export const marqueeRectTool = makeMarquee('rect');
export const marqueeEllipseTool = makeMarquee('ellipse');

// ---------- лассо ----------

function drawPoly(ctx: CanvasRenderingContext2D, v: { panX: number; panY: number; zoom: number }, pts: Point[], extra?: Point) {
  if (!pts.length) return;
  ctx.save();
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(v, p);
    if (i) ctx.lineTo(s.x, s.y);
    else ctx.moveTo(s.x, s.y);
  });
  if (extra) {
    const s = toScreen(v, extra);
    ctx.lineTo(s.x, s.y);
  }
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.restore();
}

export const lassoTool: Tool = (() => {
  let pts: Point[] = [];
  let mode: SelectMode = 'replace';
  return {
    cursor: () => 'crosshair',
    down(p) {
      mode = modeFrom(p);
      pts = [{ x: p.x, y: p.y }];
    },
    drag(p) {
      if (!pts.length) return;
      const l = pts[pts.length - 1];
      if (Math.hypot(l.x - p.x, l.y - p.y) > 0.5) pts.push({ x: p.x, y: p.y });
      requestRender();
    },
    up(_p, doc) {
      const points = pts;
      pts = [];
      if (points.length < 3) {
        if (mode === 'replace') doc.setSelection(null);
        return changed();
      }
      applyShape(doc, { kind: 'poly', points }, mode);
    },
    deactivate() {
      pts = [];
    },
    overlay(ctx, v) {
      drawPoly(ctx, v, pts);
    },
  };
})();

export const polygonLassoTool: Tool = (() => {
  let pts: Point[] = [];
  let hover: Point | null = null;
  let mode: SelectMode = 'replace';
  const finish = (doc: Doc) => {
    const points = pts;
    pts = [];
    hover = null;
    if (points.length >= 3) applyShape(doc, { kind: 'poly', points }, mode);
    else requestRender();
  };
  return {
    cursor: () => 'crosshair',
    down(p, doc) {
      const pt = p.shift && pts.length ? constrainAngle(pts[pts.length - 1], p) : snapPoint(p, doc.view);
      if (!pts.length) {
        mode = modeFrom(p);
        pts = [pt];
        return;
      }
      // клик рядом с первой точкой замыкает контур
      const first = toScreen(doc.view, pts[0]);
      if (pts.length >= 3 && Math.hypot(first.x - p.sx, first.y - p.sy) < 8) return finish(doc);
      pts.push(pt);
      requestRender();
    },
    hover(p, doc) {
      hover = p.shift && pts.length ? constrainAngle(pts[pts.length - 1], p) : snapPoint(p, doc.view);
      if (pts.length) requestRender();
    },
    dblclick(_p, doc) {
      finish(doc);
    },
    key(e, doc) {
      if (!pts.length) return false;
      if (e.key === 'Enter') finish(doc);
      else if (e.key === 'Escape') {
        pts = [];
        requestRender();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        pts.pop();
        requestRender();
      } else return false;
      return true;
    },
    deactivate(doc) {
      if (doc && pts.length >= 3) finish(doc);
      pts = [];
    },
    overlay(ctx, v) {
      drawPoly(ctx, v, pts, hover ?? undefined);
      if (pts.length) {
        const f = toScreen(v, pts[0]);
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(f.x - 3.5, f.y - 3.5, 7, 7);
      }
    },
  };
})();

function constrainAngle(a: Point, p: Point): Point {
  const dx = p.x - a.x, dy = p.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: Math.round(a.x + Math.cos(ang) * len), y: Math.round(a.y + Math.sin(ang) * len) };
}

// ---------- волшебная палочка ----------

export const wandTool: Tool = {
  cursor: () => 'crosshair',
  down(p, doc) {
    const o = app().opts;
    const src = o.wandSampleMerged ? compositeForView(doc) : doc.activeLayer?.canvas;
    if (!src) return;
    const mask = floodMask(src, p.x, p.y, { tolerance: o.wandTolerance, contiguous: o.wandContiguous });
    if (!mask) return;
    applyShape(doc, { kind: 'mask', mask }, modeFrom(p));
  },
};
