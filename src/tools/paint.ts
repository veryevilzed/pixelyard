import { createCanvas, ctx2d, rgbaToCss, unionRect } from '../core/canvas';
import type { Doc } from '../core/doc';
import { maskedCopy } from '../core/selection';
import type { Point, Rect, RGBA } from '../core/types';
import { app, setFg, toast } from '../store';
import { changed, editableLayer, requestRender, type PointerInfo, type Tool } from './base';
import { sampleColor } from './sample';

type Kind = 'brush' | 'pencil' | 'eraser' | 'stamp';

interface Stroke {
  doc: Doc;
  layerId: string;
  buffer: HTMLCanvasElement;
  erase: boolean;
  aliased: boolean;
  round: boolean;
  opacity: number;
  color: RGBA;
  bbox: Rect | null;
  last: Point;
  /** Остаток расстояния до следующего штампа. */
  carry: number;
  /** Пиксели карандаша (для pixel-perfect). */
  pixels: Point[] | null;
  /** Штамп: снимок источника и смещение (точка мазка − точка источника). */
  clone: { src: HTMLCanvasElement; dx: number; dy: number } | null;
}

/**
 * Источник штампа: Alt+клик запоминает слой и точку. При «выравнивании» смещение
 * фиксируется первым мазком и сохраняется для следующих (как в Photoshop).
 */
let cloneSource: { docId: string; layerId: string; x: number; y: number; offset: Point | null } | null = null;
export const stampSource = () => cloneSource;

let stroke: Stroke | null = null;
let hoverPt: Point | null = null;
/** Конец предыдущего мазка — для Shift+клик прямой линии. */
const lastEnd = new Map<string, Point>();

const stampCache = new Map<string, HTMLCanvasElement>();
function softStamp(size: number, hardness: number, color: RGBA): HTMLCanvasElement {
  const key = `${size.toFixed(1)}|${hardness}|${color.join(',')}`;
  let s = stampCache.get(key);
  if (s) return s;
  const d = Math.ceil(size) + 2;
  s = createCanvas(d, d);
  const ctx = ctx2d(s);
  const r = size / 2;
  const g = ctx.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, r);
  const css = rgbaToCss([color[0], color[1], color[2], 255]);
  const transparent = rgbaToCss([color[0], color[1], color[2], 0]);
  // у жёсткой кисти оставляем ~1.2px плавного края — это и есть сглаживание контура
  const aaStop = Math.max(0, 1 - 1.2 / Math.max(r, 0.6));
  g.addColorStop(0, css);
  g.addColorStop(Math.min(aaStop, hardness / 100), css);
  g.addColorStop(1, transparent);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(d / 2, d / 2, r, 0, Math.PI * 2);
  ctx.fill();
  if (stampCache.size > 64) stampCache.clear();
  stampCache.set(key, s);
  return s;
}

function settings(kind: Kind) {
  const o = app().opts;
  if (kind === 'brush') return { size: o.brushSize, hardness: o.brushHardness, opacity: o.brushOpacity / 100, aliased: !o.brushAntialias, round: true };
  if (kind === 'stamp') return { size: o.stampSize, hardness: o.stampHardness, opacity: o.stampOpacity / 100, aliased: false, round: true };
  if (kind === 'pencil') return { size: o.pencilSize, hardness: 100, opacity: o.brushOpacity / 100, aliased: true, round: o.pencilShape === 'round' };
  return {
    size: o.eraserSize,
    hardness: o.eraserHardness,
    opacity: o.eraserOpacity / 100,
    aliased: o.eraserMode === 'pencil',
    round: o.pencilShape === 'round',
  };
}

/** Смещения пикселей «карандашного» штампа размера n относительно центрального пикселя. */
const pencilOffsets = new Map<string, Point[]>();
function pencilShape(n: number, round: boolean): Point[] {
  const key = `${n}|${round}`;
  let pts = pencilOffsets.get(key);
  if (pts) return pts;
  pts = [];
  const o = Math.floor((n - 1) / 2);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (round && n > 2 && (x - c) ** 2 + (y - c) ** 2 > (n / 2) ** 2 - 0.25) continue;
      pts.push({ x: x - o, y: y - o });
    }
  pencilOffsets.set(key, pts);
  return pts;
}

function grow(s: Stroke, r: Rect) {
  s.bbox = s.bbox ? unionRect(s.bbox, r) : r;
}

function stampSoft(s: Stroke, x: number, y: number, size: number, hardness: number) {
  const st = softStamp(Math.max(1, size), hardness, s.color);
  const ctx = ctx2d(s.buffer);
  const half = st.width / 2;
  ctx.drawImage(st, x - half, y - half);
  grow(s, { x: Math.floor(x - half), y: Math.floor(y - half), w: st.width + 1, h: st.height + 1 });
}

function stampPixel(s: Stroke, px: number, py: number, size: number) {
  const ctx = ctx2d(s.buffer);
  ctx.fillStyle = rgbaToCss([s.color[0], s.color[1], s.color[2], 255]);
  const shape = pencilShape(size, s.round);
  if (shape.length === size * size) {
    const o = Math.floor((size - 1) / 2);
    ctx.fillRect(px - o, py - o, size, size);
  } else for (const p of shape) ctx.fillRect(px + p.x, py + p.y, 1, 1);
  const o = Math.floor((size - 1) / 2);
  grow(s, { x: px - o, y: py - o, w: size, h: size });
}

/** Брезенхем между пикселями a и b (включая концы, без повтора a). */
function linePixels(a: Point, b: Point, includeStart: boolean): Point[] {
  const out: Point[] = [];
  let x0 = a.x, y0 = a.y;
  const dx = Math.abs(b.x - x0), dy = -Math.abs(b.y - y0);
  const sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
  let err = dx + dy;
  if (includeStart) out.push({ x: x0, y: y0 });
  while (x0 !== b.x || y0 !== b.y) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
    out.push({ x: x0, y: y0 });
  }
  return out;
}

/** Удаляет «уголки» L-образных ступенек — линия в 1 пиксель остаётся чистой. */
function pushPixelPerfect(list: Point[], p: Point) {
  const last = list[list.length - 1];
  if (last && last.x === p.x && last.y === p.y) return;
  list.push(p);
  const n = list.length;
  if (n >= 3) {
    const a = list[n - 3], b = list[n - 2], c = list[n - 1];
    const diag = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1;
    const adjA = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
    const adjC = Math.abs(c.x - b.x) + Math.abs(c.y - b.y) === 1;
    if (diag && adjA && adjC) list.splice(n - 2, 1);
  }
}

function extend(kind: Kind, s: Stroke, to: Point, pressure: number) {
  const st = settings(kind);
  const o = app().opts;
  const size = o.pressure && pressure > 0 && pressure < 1 ? Math.max(1, st.size * pressure) : st.size;
  if (s.aliased) {
    const a = { x: Math.floor(s.last.x), y: Math.floor(s.last.y) };
    const b = { x: Math.floor(to.x), y: Math.floor(to.y) };
    const isize = Math.max(1, Math.round(size));
    if (s.pixels && isize === 1) {
      for (const p of linePixels(a, b, s.pixels.length === 0)) pushPixelPerfect(s.pixels, p);
      // перерисовка всего мазка: уже нарисованный «уголок» мог быть удалён
      const ctx = ctx2d(s.buffer);
      if (s.bbox) ctx.clearRect(s.bbox.x, s.bbox.y, s.bbox.w, s.bbox.h);
      for (const p of s.pixels) stampPixel(s, p.x, p.y, 1);
    } else {
      for (const p of linePixels(a, b, s.carry === 0)) stampPixel(s, p.x, p.y, isize);
      s.carry = 1;
    }
  } else {
    const spacing = Math.max(0.5, (size * o.brushSpacing) / 100);
    const dx = to.x - s.last.x, dy = to.y - s.last.y;
    const dist = Math.hypot(dx, dy);
    if (s.carry < 0) {
      stampSoft(s, s.last.x, s.last.y, size, st.hardness);
      s.carry = 0;
    }
    let t = spacing - s.carry;
    while (t <= dist) {
      stampSoft(s, s.last.x + (dx * t) / dist, s.last.y + (dy * t) / dist, size, st.hardness);
      t += spacing;
    }
    s.carry = dist - (t - spacing);
  }
  s.last = to;
}

/** Что кладётся на слой: для кисти — сам буфер, для штампа — источник по маске мазка. */
let cloneScratch: HTMLCanvasElement | null = null;
function strokeLayer(s: Stroke): HTMLCanvasElement {
  const mask = s.doc.selection ? maskedCopy(s.buffer, s.doc.selection) : s.buffer;
  if (!s.clone) return mask;
  if (!cloneScratch || cloneScratch.width !== s.buffer.width || cloneScratch.height !== s.buffer.height) cloneScratch = createCanvas(s.buffer.width, s.buffer.height);
  const t = ctx2d(cloneScratch);
  t.globalCompositeOperation = 'source-over';
  t.clearRect(0, 0, cloneScratch.width, cloneScratch.height);
  t.drawImage(s.clone.src, s.clone.dx, s.clone.dy);
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(mask, 0, 0);
  t.globalCompositeOperation = 'source-over';
  return cloneScratch;
}

function installPreview(s: Stroke) {
  s.doc.preview = {
    layerId: s.layerId,
    draw(ctx, layer) {
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.globalAlpha = s.opacity;
      ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
      ctx.drawImage(strokeLayer(s), 0, 0);
    },
  };
}

function commit() {
  const s = stroke;
  stroke = null;
  if (!s) return;
  s.doc.preview = null;
  lastEnd.set(s.doc.id, s.last);
  if (!s.bbox) return changed();
  const buf = strokeLayer(s);
  const labels: Record<string, string> = { brush: 'Кисть', pencil: 'Карандаш', eraser: 'Ластик', stamp: 'Штамп' };
  s.doc.pixelEdit(s.layerId, s.bbox, labels[currentKind], (ctx) => {
    ctx.globalAlpha = s.opacity;
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.drawImage(buf, 0, 0);
  });
  changed();
}

let currentKind: Kind = 'brush';

function makePaintTool(kind: Kind): Tool {
  return {
    cursor: () => 'none',
    down(p, doc) {
      if (kind === 'stamp' && p.alt) {
        // Alt+клик — источник: активный слой и точка
        if (!doc.activeLayerId) return;
        cloneSource = { docId: doc.id, layerId: doc.activeLayerId, x: p.x, y: p.y, offset: null };
        toast(`Источник штампа: «${doc.activeLayer?.name}», ${Math.round(p.x)}, ${Math.round(p.y)}`);
        return requestRender();
      }
      if (p.alt && kind !== 'eraser') {
        const c = sampleColor(doc, p.x, p.y, app().opts.eyedropperMerged);
        if (c) setFg(c);
        return;
      }
      let clone: Stroke['clone'] = null;
      if (kind === 'stamp') {
        const src = cloneSource;
        if (!src || src.docId !== doc.id) return void toast('Сначала задайте источник: ⌥+клик по нужному месту (на нужном слое)', 'error');
        const srcLayer = doc.getLayer(src.layerId);
        if (!srcLayer && app().opts.stampSample === 'layer') return void toast('Слой-источник удалён — задайте источник заново (⌥+клик)', 'error');
        const o = app().opts;
        const offset = o.stampAligned && src.offset ? src.offset : { x: p.x - src.x, y: p.y - src.y };
        if (o.stampAligned) src.offset = offset;
        // снимок: правки этого мазка не попадают в источник (можно клонировать в тот же слой)
        const snap = createCanvas(doc.width, doc.height);
        ctx2d(snap).drawImage(o.stampSample === 'all' ? doc.composite() : srcLayer!.canvas, 0, 0);
        clone = { src: snap, dx: Math.round(offset.x), dy: Math.round(offset.y) };
      }
      const layer = editableLayer(doc);
      if (!layer) return;
      currentKind = kind;
      const st = settings(kind);
      const pencilPerfect = st.aliased && app().opts.pixelPerfect && Math.round(st.size) === 1;
      const start = p.shift && lastEnd.has(doc.id) ? lastEnd.get(doc.id)! : { x: p.x, y: p.y };
      stroke = {
        doc,
        layerId: layer.id,
        buffer: createCanvas(doc.width, doc.height),
        erase: kind === 'eraser',
        aliased: st.aliased,
        round: st.round,
        opacity: st.opacity,
        color: kind === 'eraser' || kind === 'stamp' ? [0, 0, 0, 255] : app().fg,
        bbox: null,
        last: start,
        carry: -1,
        pixels: pencilPerfect ? [] : null,
        clone,
      };
      if (st.aliased) stroke.carry = 0;
      installPreview(stroke);
      extend(kind, stroke, { x: p.x, y: p.y }, p.pressure);
      requestRender();
    },
    drag(p) {
      hoverPt = { x: p.x, y: p.y };
      if (!stroke) return;
      extend(kind, stroke, { x: p.x, y: p.y }, p.pressure);
      requestRender();
    },
    hover(p) {
      hoverPt = { x: p.x, y: p.y };
      requestRender();
    },
    up() {
      commit();
    },
    deactivate() {
      commit();
      hoverPt = null;
    },
    overlay(ctx, v, doc) {
      if (kind === 'stamp' && cloneSource && cloneSource.docId === doc.id) {
        // где сейчас берётся источник: при мазке — по смещению мазка, до него — сама точка источника
        const off = stroke?.clone ? { x: stroke.clone.dx, y: stroke.clone.dy } : app().opts.stampAligned && cloneSource.offset ? cloneSource.offset : null;
        const sp = off && hoverPt ? { x: hoverPt.x - off.x, y: hoverPt.y - off.y } : { x: cloneSource.x, y: cloneSource.y };
        const cx = v.panX + sp.x * v.zoom, cy = v.panY + sp.y * v.zoom;
        ctx.save();
        for (const [col, w] of [['rgba(0,0,0,0.8)', 3], ['#fff', 1]] as const) {
          ctx.strokeStyle = col;
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(cx - 9, cy);
          ctx.lineTo(cx + 9, cy);
          ctx.moveTo(cx, cy - 9);
          ctx.lineTo(cx, cy + 9);
          ctx.stroke();
        }
        ctx.restore();
      }
      if (!hoverPt) return;
      const st = settings(kind);
      ctx.save();
      if (st.aliased) {
        const n = Math.max(1, Math.round(st.size));
        const o = Math.floor((n - 1) / 2);
        const px = Math.floor(hoverPt.x) - o, py = Math.floor(hoverPt.y) - o;
        const x = v.panX + px * v.zoom, y = v.panY + py * v.zoom;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, n * v.zoom + 1, n * v.zoom + 1);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, n * v.zoom - 1, n * v.zoom - 1);
      } else {
        const r = Math.max(1.5, (st.size / 2) * v.zoom);
        const cx = v.panX + hoverPt.x * v.zoom, cy = v.panY + hoverPt.y * v.zoom;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 0.75;
        ctx.stroke();
        if (r < 4) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(cx - 0.5, cy - 4, 1, 8);
          ctx.fillRect(cx - 4, cy - 0.5, 8, 1);
        }
      }
      ctx.restore();
    },
  };
}

export const brushTool = makePaintTool('brush');
export const pencilTool = makePaintTool('pencil');
export const eraserTool = makePaintTool('eraser');
export const stampTool = makePaintTool('stamp');

export function clearPaintHover() {
  hoverPt = null;
}

export type { PointerInfo };
