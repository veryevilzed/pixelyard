import { createCanvas, ctx2d, normRect } from '../core/canvas';
import type { Doc } from '../core/doc';
import { floodMaskData } from '../core/flood';
import { compositeForView, toScreen } from '../core/render';
import { combineSelection, featherSelection, selectionFromMask, shapeMask, type ShapeSpec } from '../core/selection';
import type { Point, Rect, SelectMode } from '../core/types';
import { app } from '../store';
import { changed, dashedRect, infoLabel, requestRender, snapPoint, type PointerInfo, type Tool } from './base';

/** ⇧ — добавить, ⌥ или Ctrl — вычесть, ⇧ вместе с ⌥/Ctrl — пересечение. */
function modeFrom(p: PointerInfo): SelectMode {
  const sub = p.alt || p.ctrl;
  if (p.shift && sub) return 'intersect';
  if (p.shift) return 'add';
  if (sub) return 'subtract';
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
        // повторный клик внутри выделения без сдвига — снять выделение (как в Photoshop)
        if (!dx && !dy) {
          doc.setSelection(null);
          return changed();
        }
        if (doc.selection) {
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

/**
 * Клик — выделить похожие пиксели. Если не отпускать кнопку и вести мышь вправо/влево,
 * допуск растёт/уменьшается и выделение пересчитывается на лету.
 */
interface WandState {
  x: number;
  y: number;
  sx: number;
  sy: number;
  base: number;
  tol: number;
  mode: SelectMode;
  data: Uint8ClampedArray;
  w: number;
  h: number;
  mask: HTMLCanvasElement | null;
  /** Маска для показа: цветная заливка выделенного. */
  tint: HTMLCanvasElement | null;
  raf: number;
}
let wand: WandState | null = null;

function wandCompute(s: WandState) {
  const o = app().opts;
  s.mask = floodMaskData(s.data, s.w, s.h, s.x, s.y, { tolerance: s.tol, contiguous: o.wandContiguous, antialias: o.selectAntialias });
  if (!s.mask) return (s.tint = null);
  const t = s.tint && s.tint.width === s.w && s.tint.height === s.h ? s.tint : createCanvas(s.w, s.h);
  const tc = ctx2d(t);
  tc.globalCompositeOperation = 'source-over';
  tc.clearRect(0, 0, s.w, s.h);
  tc.drawImage(s.mask, 0, 0);
  tc.globalCompositeOperation = 'source-in';
  tc.fillStyle = s.mode === 'subtract' ? 'rgba(255,60,60,0.45)' : 'rgba(40,140,255,0.45)';
  tc.fillRect(0, 0, s.w, s.h);
  s.tint = t;
}

export const wandTool: Tool = {
  cursor: () => 'crosshair',
  down(p, doc) {
    const o = app().opts;
    const src = o.wandSampleMerged ? compositeForView(doc) : doc.activeLayer?.canvas;
    if (!src) return;
    const data = ctx2d(src).getImageData(0, 0, src.width, src.height).data;
    wand = { x: p.x, y: p.y, sx: p.sx, sy: p.sy, base: o.wandTolerance, tol: o.wandTolerance, mode: modeFrom(p), data, w: src.width, h: src.height, mask: null, tint: null, raf: 0 };
    wandCompute(wand);
    requestRender();
  },
  drag(p) {
    const s = wand;
    if (!s) return;
    // вправо/вверх — больше, влево/вниз — меньше; 2 px экрана = 1 единица допуска
    const d = (p.sx - s.sx - (p.sy - s.sy)) / 2;
    const tol = Math.round(Math.max(0, Math.min(255, s.base + d)));
    if (tol === s.tol) return;
    s.tol = tol;
    if (!s.raf)
      s.raf = requestAnimationFrame(() => {
        s.raf = 0;
        wandCompute(s);
        requestRender();
      });
  },
  up(_p, doc) {
    const s = wand;
    wand = null;
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    wandCompute(s);
    if (!s.mask) return requestRender();
    applyShape(doc, { kind: 'mask', mask: s.mask }, s.mode);
  },
  deactivate() {
    if (wand?.raf) cancelAnimationFrame(wand.raf);
    wand = null;
  },
  overlay(ctx, v) {
    const s = wand;
    if (!s?.tint) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(s.tint, v.panX, v.panY, s.w * v.zoom, s.h * v.zoom);
    ctx.restore();
    const at = toScreen(v, { x: s.x, y: s.y });
    infoLabel(ctx, `Допуск ${s.tol}${s.tol !== s.base ? ` (было ${s.base})` : ''} — ведите мышь вправо/влево`, at.x + 14, at.y + 14);
  },
};
