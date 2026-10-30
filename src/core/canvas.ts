import type { Rect, RGBA } from './types';

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D недоступен');
  return ctx;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

export function canvasFrom(source: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  ctx2d(c).drawImage(source, 0, 0);
  return c;
}

export function canvasFromImageData(data: ImageData): HTMLCanvasElement {
  const c = createCanvas(data.width, data.height);
  ctx2d(c).putImageData(data, 0, 0);
  return c;
}

export function getImageData(c: HTMLCanvasElement, r?: Rect): ImageData {
  const rr = r ?? { x: 0, y: 0, w: c.width, h: c.height };
  return ctx2d(c).getImageData(rr.x, rr.y, Math.max(1, rr.w), Math.max(1, rr.h));
}

/** Ограничивающий прямоугольник непрозрачных пикселей или null, если пусто. */
export function alphaBounds(c: HTMLCanvasElement, threshold = 0): Rect | null {
  const { width: w, height: h } = c;
  const d = getImageData(c).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4 + 3;
    for (let x = 0; x < w; x++, row += 4) {
      if (d[row] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function cropCanvas(c: HTMLCanvasElement, r: Rect): HTMLCanvasElement {
  const out = createCanvas(r.w, r.h);
  ctx2d(out).drawImage(c, -r.x, -r.y);
  return out;
}

export function scaleCanvas(c: HTMLCanvasElement, w: number, h: number, smooth: boolean): HTMLCanvasElement {
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  if (smooth && (w < c.width / 2 || h < c.height / 2)) {
    // Многошаговое уменьшение даёт заметно меньше алиасинга.
    let cur = c;
    while (cur.width / 2 > w && cur.height / 2 > h) {
      const half = createCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
      const hc = ctx2d(half);
      hc.imageSmoothingQuality = 'high';
      hc.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    ctx.drawImage(cur, 0, 0, w, h);
  } else {
    ctx.drawImage(c, 0, 0, w, h);
  }
  return out;
}

export function isEmptyRect(r: Rect | null | undefined): boolean {
  return !r || r.w <= 0 || r.h <= 0;
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return null;
  return { x, y, w: r - x, h: bt - y };
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export function roundRect(r: Rect): Rect {
  const x = Math.round(r.x), y = Math.round(r.y);
  return { x, y, w: Math.round(r.x + r.w) - x, h: Math.round(r.y + r.h) - y };
}

export function rgbaToCss([r, g, b, a]: RGBA): string {
  return `rgba(${r},${g},${b},${a / 255})`;
}

export function rgbaToHex([r, g, b]: RGBA): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hexToRgba(hex: string, alpha = 255): RGBA | null {
  const m = hex.trim().replace(/^#/, '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null;
  const n = parseInt(full.slice(0, 6), 16);
  const a = full.length === 8 ? parseInt(full.slice(6), 16) : alpha;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

export function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось закодировать изображение'))), type, quality),
  );
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
