import { alphaBounds, createCanvas, ctx2d } from './canvas';
import { blurImageData } from './filters';
import type { Point, Rect, Selection, SelectMode } from './types';

/** Строит выделение по маске; null, если маска пустая. */
export function selectionFromMask(mask: HTMLCanvasElement): Selection | null {
  const bounds = alphaBounds(mask, 0);
  if (!bounds) return null;
  return { mask, bounds, outline: buildOutline(mask, bounds) };
}

/**
 * Контур по границе пикселей с альфой > 127. Соседние горизонтальные/вертикальные
 * отрезки склеиваются, чтобы Path2D оставался компактным.
 */
function buildOutline(mask: HTMLCanvasElement, b: Rect): Path2D {
  const w = mask.width, h = mask.height;
  const d = ctx2d(mask).getImageData(0, 0, w, h).data;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 127;
  const p = new Path2D();
  const x0 = Math.max(0, b.x - 1), x1 = Math.min(w, b.x + b.w + 1);
  const y0 = Math.max(0, b.y - 1), y1 = Math.min(h, b.y + b.h + 1);
  // горизонтальные границы между строками y-1 и y
  for (let y = y0; y <= y1; y++) {
    let start = -1;
    for (let x = x0; x <= x1; x++) {
      const edge = x < x1 && inside(x, y) !== inside(x, y - 1);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        p.moveTo(start, y);
        p.lineTo(x, y);
        start = -1;
      }
    }
  }
  // вертикальные границы между столбцами x-1 и x
  for (let x = x0; x <= x1; x++) {
    let start = -1;
    for (let y = y0; y <= y1; y++) {
      const edge = y < y1 && inside(x, y) !== inside(x - 1, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        p.moveTo(x, start);
        p.lineTo(x, y);
        start = -1;
      }
    }
  }
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
): Selection | null {
  if (mode === 'replace' || !current) {
    if (mode === 'subtract' || mode === 'intersect') return mode === 'intersect' ? null : current;
    return selectionFromMask(shape);
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
  return selectionFromMask(m)!;
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
