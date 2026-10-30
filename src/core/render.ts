import { createCanvas, ctx2d } from './canvas';
import { compositeLayers, grayToMask, renderLayerContent } from './composite';
import type { Doc, ViewState } from './doc';
import type { ViewPrefs } from '../store';
import type { Point, Rect } from './types';

export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
  dpr: number;
}

export const toScreen = (v: ViewState, p: Point): Point => ({ x: v.panX + p.x * v.zoom, y: v.panY + p.y * v.zoom });
export const toDoc = (v: ViewState, p: Point): Point => ({ x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom });
export const rectToScreen = (v: ViewState, r: Rect): Rect => ({ x: v.panX + r.x * v.zoom, y: v.panY + r.y * v.zoom, w: r.w * v.zoom, h: r.h * v.zoom });

export const ZOOM_STEPS = [0.02, 0.05, 0.0833, 0.125, 0.1667, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

export function fitView(doc: Doc, vw: number, vh: number): ViewState {
  const pad = 40;
  const zoom = Math.min(16, (vw - pad * 2) / doc.width, (vh - pad * 2) / doc.height);
  const z = zoom >= 1 ? Math.floor(zoom) : zoom; // при увеличении — целый масштаб, чтобы пиксели были ровными
  return { zoom: z, panX: Math.round((vw - doc.width * z) / 2), panY: Math.round((vh - doc.height * z) / 2) };
}

export function zoomAt(v: ViewState, newZoom: number, sx: number, sy: number): ViewState {
  const z = Math.min(64, Math.max(0.02, newZoom));
  const dx = (sx - v.panX) / v.zoom, dy = (sy - v.panY) / v.zoom;
  return { zoom: z, panX: sx - dx * z, panY: sy - dy * z };
}

/** Сколько пустого места (экранные px) можно открыть за краем картинки. */
export const PAN_MARGIN = 64;

/**
 * Ограничивает прокрутку: большая картинка не уходит дальше PAN_MARGIN за край,
 * а если по оси помещается целиком — стоит по центру, как в Photoshop.
 * offset — место под линейки.
 */
export function clampView(v: ViewState, docW: number, docH: number, vw: number, vh: number, offset = 0): ViewState {
  const axis = (pan: number, size: number, view: number) => {
    const lo = offset + PAN_MARGIN;
    const hi = view - size - PAN_MARGIN;
    if (hi >= lo) return Math.round(offset + (view - offset - size) / 2);
    return Math.min(lo, Math.max(hi, pan));
  };
  const panX = axis(v.panX, docW * v.zoom, vw);
  const panY = axis(v.panY, docH * v.zoom, vh);
  return panX === v.panX && panY === v.panY ? v : { ...v, panX, panY };
}

export function nextZoom(z: number, dir: 1 | -1) {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z * 1.001) ?? 64;
  return [...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? 0.02;
}

/** Сведённое изображение для показа — своё у каждого документа (их видно в двух областях сразу). */
const comps = new WeakMap<Doc, HTMLCanvasElement>();
let scratch: HTMLCanvasElement | null = null;

/** Последнее отрисованное сведение документа (для навигатора) — без пересчёта. */
export function lastComposite(doc: Doc): HTMLCanvasElement | null {
  return comps.get(doc) ?? null;
}
const ensure = (c: HTMLCanvasElement | null, w: number, h: number) => {
  if (!c || c.width !== w || c.height !== h) return createCanvas(w, h);
  return c;
};

/** Сводит слои документа с учётом превью активного инструмента. */
export function compositeForView(doc: Doc): HTMLCanvasElement {
  const comp = ensure(comps.get(doc) ?? null, doc.width, doc.height);
  comps.set(doc, comp);
  scratch = ensure(scratch, doc.width, doc.height);
  const ctx = ctx2d(comp);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, doc.width, doc.height);
  const preview = doc.preview;
  const editingMask = doc.editingMask;
  compositeLayers(doc, ctx, {
    getContent: (l) => {
      if (!preview || preview.layerId !== l.id) return null;
      const sctx = ctx2d(scratch!);
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, doc.width, doc.height);
      if (editingMask && l.id === doc.activeLayerId) {
        // превью правки маски: инструмент рисует в серую маску, показываем результат на слое
        preview.draw(sctx, { ...l, canvas: doc.editSource(l) });
        sctx.restore();
        return renderLayerContent({ ...l, maskEnabled: true }, l.canvas, grayToMask(scratch!));
      }
      preview.draw(sctx, l);
      sctx.restore();
      return renderLayerContent(l, scratch!, l.mask);
    },
  });
  return comp;
}

let checkerPattern: { key: string; pattern: CanvasPattern } | null = null;
function checker(ctx: CanvasRenderingContext2D, mode: ViewPrefs['checker'], dpr: number) {
  const key = mode + dpr;
  if (checkerPattern?.key === key) return checkerPattern.pattern;
  const s = Math.round(8 * dpr);
  const c = createCanvas(s * 2, s * 2);
  const cc = ctx2d(c);
  const [a, b] = mode === 'dark' ? ['#3a3a3a', '#2e2e2e'] : ['#ffffff', '#d6d6d6'];
  cc.fillStyle = a;
  cc.fillRect(0, 0, s * 2, s * 2);
  cc.fillStyle = b;
  cc.fillRect(0, 0, s, s);
  cc.fillRect(s, s, s, s);
  checkerPattern = { key, pattern: ctx.createPattern(c, 'repeat')! };
  return checkerPattern.pattern;
}

export interface RenderInput {
  doc: Doc;
  view: ViewState;
  prefs: ViewPrefs;
  dpr: number;
  antsOffset: number;
  composite: HTMLCanvasElement;
  overlay?: (ctx: CanvasRenderingContext2D, v: ViewTransform) => void;
  hideSelection?: boolean;
  /** Позиция курсора в координатах документа — метка на линейках. */
  cursor?: { x: number; y: number } | null;
  /** Направляющая, которую сейчас тянут (ещё не добавлена). */
  draftGuide?: { axis: 'x' | 'y'; value: number } | null;
}

export const RULER = 18;

const RULER_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

function drawGuides(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewState, W: number, H: number, draft: RenderInput['draftGuide']) {
  ctx.save();
  ctx.lineWidth = 1;
  const line = (axis: 'x' | 'y', v: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (axis === 'x') {
      const sx = Math.round(view.panX + v * view.zoom) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, H);
    } else {
      const sy = Math.round(view.panY + v * view.zoom) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(W, sy);
    }
    ctx.stroke();
  };
  for (const x of doc.guides.x) line('x', x, 'rgba(0,210,255,0.9)');
  for (const y of doc.guides.y) line('y', y, 'rgba(0,210,255,0.9)');
  if (draft) line(draft.axis, draft.value, 'rgba(0,210,255,0.6)');
  ctx.restore();
}

function drawRulers(ctx: CanvasRenderingContext2D, view: ViewState, W: number, H: number, cursor: RenderInput['cursor']) {
  // шаг делений: чтобы подписи стояли не чаще ~60 экранных пикселей
  const step = RULER_STEPS.find((s) => s * view.zoom >= 60) ?? 10000;
  const minor = step / (step % 5 === 0 || step === 1 ? 5 : step % 2 === 0 ? 2 : 1);
  ctx.save();
  ctx.fillStyle = '#232327';
  ctx.fillRect(0, 0, W, RULER);
  ctx.fillRect(0, 0, RULER, H);
  ctx.strokeStyle = '#55555c';
  ctx.fillStyle = '#9a9aa2';
  ctx.font = '9px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const x0 = Math.floor(-view.panX / view.zoom / minor) * minor;
  for (let v = x0; view.panX + v * view.zoom < W; v += minor) {
    const sx = Math.round(view.panX + v * view.zoom) + 0.5;
    if (sx < RULER) continue;
    const major = Math.abs(v % step) < 1e-6;
    ctx.moveTo(sx, major ? 0 : RULER - 5);
    ctx.lineTo(sx, RULER);
    if (major) ctx.fillText(String(Math.round(v)), sx + 2, 2);
  }
  const y0 = Math.floor(-view.panY / view.zoom / minor) * minor;
  for (let v = y0; view.panY + v * view.zoom < H; v += minor) {
    const sy = Math.round(view.panY + v * view.zoom) + 0.5;
    if (sy < RULER) continue;
    const major = Math.abs(v % step) < 1e-6;
    ctx.moveTo(major ? 0 : RULER - 5, sy);
    ctx.lineTo(RULER, sy);
    if (major) {
      ctx.save();
      ctx.translate(2, sy + 2);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(String(Math.round(v)), 0, -9);
      ctx.restore();
    }
  }
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(W, RULER + 0.5);
  ctx.moveTo(RULER + 0.5, 0);
  ctx.lineTo(RULER + 0.5, H);
  ctx.stroke();
  if (cursor) {
    ctx.strokeStyle = '#3b82f6';
    ctx.beginPath();
    const cx = Math.round(view.panX + cursor.x * view.zoom) + 0.5;
    const cy = Math.round(view.panY + cursor.y * view.zoom) + 0.5;
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, RULER);
    ctx.moveTo(0, cy);
    ctx.lineTo(RULER, cy);
    ctx.stroke();
  }
  ctx.fillStyle = '#1b1b1d';
  ctx.fillRect(0, 0, RULER, RULER);
  ctx.restore();
}

export function renderView(canvas: HTMLCanvasElement, r: RenderInput) {
  const { doc, view, prefs, dpr } = r;
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#1b1b1d';
  ctx.fillRect(0, 0, W, H);

  const dr = rectToScreen(view, { x: 0, y: 0, w: doc.width, h: doc.height });
  // тень документа
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(dr.x + 3, dr.y + 3, dr.w, dr.h);
  // шахматка рисуется в экранных координатах — клетки не масштабируются
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = checker(ctx, prefs.checker, dpr);
  ctx.fillRect(dr.x * dpr, dr.y * dpr, dr.w * dpr, dr.h * dpr);
  ctx.restore();

  ctx.imageSmoothingEnabled = view.zoom < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(r.composite, dr.x, dr.y, dr.w, dr.h);

  const vis = {
    x0: Math.max(0, Math.floor(-view.panX / view.zoom)),
    y0: Math.max(0, Math.floor(-view.panY / view.zoom)),
    x1: Math.min(doc.width, Math.ceil((W - view.panX) / view.zoom)),
    y1: Math.min(doc.height, Math.ceil((H - view.panY) / view.zoom)),
  };

  // попиксельная сетка
  if (prefs.pixelGrid && view.zoom >= 8) {
    ctx.beginPath();
    for (let x = vis.x0; x <= vis.x1; x++) {
      const sx = Math.round(view.panX + x * view.zoom) + 0.5;
      ctx.moveTo(sx, Math.max(dr.y, 0));
      ctx.lineTo(sx, Math.min(dr.y + dr.h, H));
    }
    for (let y = vis.y0; y <= vis.y1; y++) {
      const sy = Math.round(view.panY + y * view.zoom) + 0.5;
      ctx.moveTo(Math.max(dr.x, 0), sy);
      ctx.lineTo(Math.min(dr.x + dr.w, W), sy);
    }
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // пользовательская сетка (для спрайтшитов)
  if (prefs.grid && prefs.gridW > 0 && prefs.gridH > 0 && prefs.gridW * view.zoom >= 3) {
    ctx.beginPath();
    for (let x = Math.ceil(vis.x0 / prefs.gridW) * prefs.gridW; x <= vis.x1; x += prefs.gridW) {
      const sx = Math.round(view.panX + x * view.zoom) + 0.5;
      ctx.moveTo(sx, dr.y);
      ctx.lineTo(sx, dr.y + dr.h);
    }
    for (let y = Math.ceil(vis.y0 / prefs.gridH) * prefs.gridH; y <= vis.y1; y += prefs.gridH) {
      const sy = Math.round(view.panY + y * view.zoom) + 0.5;
      ctx.moveTo(dr.x, sy);
      ctx.lineTo(dr.x + dr.w, sy);
    }
    ctx.strokeStyle = prefs.gridColor;
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(dr.x) - 0.5, Math.round(dr.y) - 0.5, Math.round(dr.w) + 1, Math.round(dr.h) + 1);

  if (prefs.slices) drawSlices(ctx, doc, view, prefs.sliceLabels);
  drawCuts(ctx, doc, view, dr);
  if (doc.nine) drawNineLines(ctx, doc, view);

  // выделение
  if (doc.selection && !r.hideSelection) {
    ctx.save();
    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);
    ctx.lineWidth = 1 / view.zoom;
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([]);
    ctx.stroke(doc.selection.outline);
    ctx.strokeStyle = '#000';
    ctx.setLineDash([4 / view.zoom, 4 / view.zoom]);
    ctx.lineDashOffset = -r.antsOffset / view.zoom;
    ctx.stroke(doc.selection.outline);
    ctx.restore();
  }

  if (prefs.guides) drawGuides(ctx, doc, view, W, H, r.draftGuide);
  r.overlay?.(ctx, { ...view, dpr });
  if (prefs.rulers) drawRulers(ctx, view, W, H, r.cursor);
}

function drawCuts(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewState, dr: Rect) {
  if (!doc.cuts.x.length && !doc.cuts.y.length) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of doc.cuts.x) {
    const sx = Math.round(view.panX + x * view.zoom) + 0.5;
    ctx.moveTo(sx, dr.y);
    ctx.lineTo(sx, dr.y + dr.h);
  }
  for (const y of doc.cuts.y) {
    const sy = Math.round(view.panY + y * view.zoom) + 0.5;
    ctx.moveTo(dr.x, sy);
    ctx.lineTo(dr.x + dr.w, sy);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.stroke();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#ff3b6b';
  ctx.stroke();
  ctx.restore();
}

function drawSlices(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewState, labels: boolean) {
  ctx.save();
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (const s of doc.slices) {
    const active = s.id === doc.activeSliceId;
    const r = rectToScreen(view, s);
    const x = Math.round(r.x) + 0.5, y = Math.round(r.y) + 0.5, w = Math.round(r.w) - 1, h = Math.round(r.h) - 1;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = active ? '#ffb02e' : 'rgba(80,170,255,0.9)';
    if (active) {
      ctx.fillStyle = 'rgba(255,176,46,0.08)';
      ctx.fillRect(x, y, w, h);
    }
    ctx.strokeRect(x, y, w, h);
    if (s.nine) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,80,200,0.9)';
      const { left, top, right, bottom } = s.nine;
      ctx.beginPath();
      for (const gx of [s.x + left, s.x + s.w - right]) {
        const sx = Math.round(view.panX + gx * view.zoom) + 0.5;
        ctx.moveTo(sx, y);
        ctx.lineTo(sx, y + h);
      }
      for (const gy of [s.y + top, s.y + s.h - bottom]) {
        const sy = Math.round(view.panY + gy * view.zoom) + 0.5;
        ctx.moveTo(x, sy);
        ctx.lineTo(x + w, sy);
      }
      ctx.stroke();
    }
    if (labels && w > 24) {
      const text = s.name;
      const tw = Math.min(ctx.measureText(text).width + 6, w);
      ctx.fillStyle = active ? '#ffb02e' : 'rgba(80,170,255,0.9)';
      ctx.fillRect(x, y, tw, 14);
      ctx.fillStyle = '#000';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, tw, 14);
      ctx.clip();
      ctx.fillText(text, x + 3, y + 1.5);
      ctx.restore();
    }
    if (active) drawHandles(ctx, r);
  }
  ctx.restore();
}

export function handlePoints(r: Rect): Point[] {
  const { x, y, w, h } = r;
  return [
    { x, y }, { x: x + w / 2, y }, { x: x + w, y },
    { x: x + w, y: y + h / 2 }, { x: x + w, y: y + h }, { x: x + w / 2, y: y + h },
    { x, y: y + h }, { x, y: y + h / 2 },
  ];
}

export function drawHandles(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 1;
  for (const p of handlePoints(r)) {
    ctx.fillRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
    ctx.strokeRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
  }
  ctx.restore();
}

/** Индекс ручки (0..7, как в handlePoints) под экранной точкой или -1. */
export function hitHandle(r: Rect, sx: number, sy: number, tol = 6): number {
  return handlePoints(r).findIndex((p) => Math.abs(p.x - sx) <= tol && Math.abs(p.y - sy) <= tol);
}

export const HANDLE_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

/** Новый прямоугольник после перетаскивания ручки handle в точку p (координаты документа). */
export function resizeByHandle(r: Rect, handle: number, p: Point): Rect {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  if ([0, 6, 7].includes(handle)) x0 = p.x;
  if ([2, 3, 4].includes(handle)) x1 = p.x;
  if ([0, 1, 2].includes(handle)) y0 = p.y;
  if ([4, 5, 6].includes(handle)) y1 = p.y;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** Линии 9-slice документа: X — левая/правая граница, Y — верхняя/нижняя. */
export function nineLines(doc: Doc): { side: 'left' | 'right' | 'top' | 'bottom'; axis: 'x' | 'y'; value: number }[] {
  const n = doc.nine;
  if (!n) return [];
  return [
    { side: 'left', axis: 'x', value: n.left },
    { side: 'right', axis: 'x', value: doc.width - n.right },
    { side: 'top', axis: 'y', value: n.top },
    { side: 'bottom', axis: 'y', value: doc.height - n.bottom },
  ];
}

function drawNineLines(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewState) {
  const r = rectToScreen(view, { x: 0, y: 0, w: doc.width, h: doc.height });
  ctx.save();
  // тянущиеся полосы чуть подсвечены
  const n = doc.nine!;
  const x0 = r.x + n.left * view.zoom, x1 = r.x + (doc.width - n.right) * view.zoom;
  const y0 = r.y + n.top * view.zoom, y1 = r.y + (doc.height - n.bottom) * view.zoom;
  ctx.fillStyle = 'rgba(0,220,160,0.07)';
  ctx.fillRect(x0, r.y, Math.max(0, x1 - x0), r.h);
  ctx.fillRect(r.x, y0, r.w, Math.max(0, y1 - y0));
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = 'rgba(0,230,170,0.95)';
  ctx.beginPath();
  for (const l of nineLines(doc)) {
    const v = Math.round((l.axis === 'x' ? r.x : r.y) + l.value * view.zoom) + 0.5;
    if (l.axis === 'x') {
      ctx.moveTo(v, r.y - 8);
      ctx.lineTo(v, r.y + r.h + 8);
    } else {
      ctx.moveTo(r.x - 8, v);
      ctx.lineTo(r.x + r.w + 8, v);
    }
  }
  ctx.stroke();
  ctx.restore();
}
