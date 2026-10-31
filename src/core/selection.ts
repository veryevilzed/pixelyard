import { createCanvas, ctx2d } from './canvas';
import { blurImageData } from './filters';
import type { Point, Rect, Selection, SelectMode } from './types';

/** Строит выделение по маске; null, если маска пустая. Границы и контур, если известны, можно передать. */
export function selectionFromMask(mask: HTMLCanvasElement, known?: { bounds: Rect; outline: Path2D }): Selection | null {
  if (known) return { mask, bounds: known.bounds, outline: known.outline };
  const scan = scanMask(mask);
  return scan && { mask, ...scan };
}

/**
 * Границы (альфа > 0) и контур по краю пикселей с альфой > 127 — за одно чтение маски.
 * Соседние отрезки контура склеиваются, чтобы Path2D оставался компактным.
 */
function scanMask(mask: HTMLCanvasElement): { bounds: Rect; outline: Path2D } | null {
  const w = mask.width, h = mask.height;
  const px = new Uint32Array(ctx2d(mask).getImageData(0, 0, w, h).data.buffer);
  // альфа — старший байт (порядок байтов little-endian, как на всех нынешних машинах)
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w && px[row + x] >>> 24 === 0) x++;
    if (x === w) continue;
    let x2 = w - 1;
    while (px[row + x2] >>> 24 === 0) x2--;
    if (x < minX) minX = x;
    if (x2 > maxX) maxX = x2;
    if (y < minY) minY = y;
    maxY = y;
  }
  if (maxX < 0) return null;
  const bounds = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  // сетка «внутри» с рамкой в 1 пиксель вокруг границ
  const gx0 = minX - 1, gy0 = minY - 1, gw = bounds.w + 2, gh = bounds.h + 2;
  const g = new Uint8Array(gw * gh);
  for (let y = minY; y <= maxY; y++) {
    const src = y * w, dst = (y - gy0) * gw - gx0;
    for (let x = minX; x <= maxX; x++) if (px[src + x] >>> 24 > 127) g[dst + x] = 1;
  }
  const p = new Path2D();
  // горизонтальные границы между строками r-1 и r
  for (let r = 1; r < gh; r++) {
    const a = (r - 1) * gw, c = r * gw;
    let start = -1;
    for (let x = 0; x <= gw; x++) {
      const edge = x < gw && g[a + x] !== g[c + x];
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        p.moveTo(gx0 + start, gy0 + r);
        p.lineTo(gx0 + x, gy0 + r);
        start = -1;
      }
    }
  }
  // вертикальные границы между столбцами c-1 и c
  for (let c = 1; c < gw; c++) {
    let start = -1;
    for (let r = 0; r <= gh; r++) {
      const edge = r < gh && g[r * gw + c] !== g[r * gw + c - 1];
      if (edge && start < 0) start = r;
      else if (!edge && start >= 0) {
        p.moveTo(gx0 + c, gy0 + start);
        p.lineTo(gx0 + c, gy0 + r);
        start = -1;
      }
    }
  }
  return { bounds, outline: p };
}

/** Контур прямоугольника (выделить всё, прямоугольная рамка). */
function rectOutline(r: Rect): Path2D {
  const p = new Path2D();
  p.rect(r.x, r.y, r.w, r.h);
  return p;
}

export type ShapeSpec =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'ellipse'; rect: Rect }
  | { kind: 'poly'; points: Point[] }
  | { kind: 'mask'; mask: HTMLCanvasElement };

export function shapeMask(w: number, h: number, shape: ShapeSpec, antialias = false): HTMLCanvasElement {
  if (shape.kind === 'mask') return shape.mask;
  const m = createCanvas(w, h);
  const ctx = ctx2d(m);
  ctx.fillStyle = '#000';
  if (shape.kind === 'rect') {
    const r = shape.rect;
    ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
  } else if (shape.kind === 'ellipse') {
    const r = shape.rect;
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    if (shape.points.length < 3) return m;
    ctx.beginPath();
    shape.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
    ctx.closePath();
    ctx.fill();
  }
  return antialias ? m : hardenMask(m);
}

/** Убирает полупрозрачные пиксели по краю — для попиксельно точных выделений. */
export function hardenMask(m: HTMLCanvasElement, threshold = 127): HTMLCanvasElement {
  const ctx = ctx2d(m);
  const img = ctx.getImageData(0, 0, m.width, m.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > threshold ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return m;
}

export function combineSelection(
  current: Selection | null,
  shape: HTMLCanvasElement,
  mode: SelectMode,
  /** Маска — ровно этот прямоугольник (рамка): границы и контур известны без чтения маски. */
  rect?: Rect,
): Selection | null {
  if (mode === 'replace' || !current) {
    if (mode === 'subtract' || mode === 'intersect') return mode === 'intersect' ? null : current;
    return selectionFromMask(shape, rect ? { bounds: rect, outline: rectOutline(rect) } : undefined);
  }
  const out = createCanvas(shape.width, shape.height);
  const ctx = ctx2d(out);
  ctx.drawImage(current.mask, 0, 0);
  ctx.globalCompositeOperation =
    mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
  ctx.drawImage(shape, 0, 0);
  return selectionFromMask(out);
}

export function selectAll(w: number, h: number): Selection {
  const m = createCanvas(w, h);
  const ctx = ctx2d(m);
  ctx.fillRect(0, 0, w, h);
  const bounds = { x: 0, y: 0, w, h };
  return selectionFromMask(m, { bounds, outline: rectOutline(bounds) })!;
}

export function invertSelection(sel: Selection | null, w: number, h: number): Selection | null {
  const m = createCanvas(w, h);
  const ctx = ctx2d(m);
  ctx.fillRect(0, 0, w, h);
  if (sel) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(sel.mask, 0, 0);
  } else return null;
  return selectionFromMask(m);
}

/** Выделение по непрозрачным пикселям слоя. */
export function selectionFromAlpha(c: HTMLCanvasElement): Selection | null {
  const m = createCanvas(c.width, c.height);
  ctx2d(m).drawImage(c, 0, 0);
  return selectionFromMask(hardenMask(m, 0));
}

/**
 * Расширение (radius > 0) или сжатие (radius < 0). Расстояние считается
 * двухпроходным chamfer-преобразованием (веса 3/4), O(w*h) при любом радиусе.
 */
export function growSelection(sel: Selection, radius: number): Selection | null {
  const { width: w, height: h } = sel.mask;
  const r = Math.abs(radius);
  if (!r) return sel;
  const img = ctx2d(sel.mask).getImageData(0, 0, w, h);
  const d = img.data;
  const grow = radius > 0;
  const INF = 1e9;
  // dist = расстояние до ближайшего «источника»: при расширении — выделенного, при сжатии — невыделенного
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const on = d[i * 4 + 3] > 127;
    dist[i] = on === grow ? 0 : INF;
  }
  const relax = (i: number, j: number, cost: number) => {
    const v = dist[j] + cost;
    if (v < dist[i]) dist[i] = v;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1, 3);
      if (y > 0) {
        relax(i, i - w, 3);
        if (x > 0) relax(i, i - w - 1, 4);
        if (x < w - 1) relax(i, i - w + 1, 4);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, i + 1, 3);
      if (y < h - 1) {
        relax(i, i + w, 3);
        if (x < w - 1) relax(i, i + w + 1, 4);
        if (x > 0) relax(i, i + w - 1, 4);
      }
    }
  }
  const limit = r * 3;
  for (let i = 0; i < w * h; i++) {
    const on = grow ? dist[i] <= limit : dist[i] > limit;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0;
    d[i * 4 + 3] = on ? 255 : 0;
  }
  const out = createCanvas(w, h);
  ctx2d(out).putImageData(img, 0, 0);
  return selectionFromMask(out);
}

export function featherSelection(sel: Selection, radius: number): Selection | null {
  const { width: w, height: h } = sel.mask;
  // ctx.filter в WebKit поддерживается не везде, поэтому размываем вручную
  const img = blurImageData(ctx2d(sel.mask).getImageData(0, 0, w, h), radius);
  const out = createCanvas(w, h);
  ctx2d(out).putImageData(img, 0, 0);
  return selectionFromMask(out);
}

/** Копия canvas, ограниченная маской выделения. */
export function maskedCopy(src: HTMLCanvasElement, sel: Selection | null): HTMLCanvasElement {
  const out = createCanvas(src.width, src.height);
  const ctx = ctx2d(out);
  ctx.drawImage(src, 0, 0);
  if (sel) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(sel.mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
  return out;
}

/** Применяет результат к слою только внутри выделения: dst = dst*(1-m) + result*m. */
export function blendThroughSelection(ctx: CanvasRenderingContext2D, result: HTMLCanvasElement, sel: Selection | null) {
  if (!sel) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(result, 0, 0);
    return;
  }
  const inside = maskedCopy(result, sel);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(sel.mask, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(inside, 0, 0);
}
