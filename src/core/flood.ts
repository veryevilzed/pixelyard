import { createCanvas, ctx2d } from './canvas';

export interface FloodOptions {
  tolerance: number; // 0..255
  contiguous: boolean;
  /** Учитывать альфу при сравнении цветов. */
  useAlpha?: boolean;
  /** Мягкий край в 1 px (как «Сглаживание» у волшебной палочки). */
  antialias?: boolean;
}

/**
 * Маска похожих пикселей по готовым RGBA-данным (для палочки: данные читаются один раз,
 * а допуск меняется на лету). Цвета сравниваются с учётом прозрачности (премультиплицированно):
 * полупрозрачный край объекта похож на прозрачный фон, а не на свой «голый» RGB.
 */
export function floodMaskData(data: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, opts: FloodOptions): HTMLCanvasElement | null {
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const si = (sy * w + sx) * 4;
  const a0 = data[si + 3];
  const r0 = (data[si] * a0) / 255, g0 = (data[si + 1] * a0) / 255, b0 = (data[si + 2] * a0) / 255;
  const tol = opts.tolerance;
  const matches = (i: number) => {
    const a = data[i + 3];
    if (Math.abs(a - a0) > tol) return false;
    const k = a / 255;
    return Math.abs(data[i] * k - r0) <= tol && Math.abs(data[i + 1] * k - g0) <= tol && Math.abs(data[i + 2] * k - b0) <= tol;
  };
  const out = new Uint8Array(w * h);
  if (opts.contiguous) {
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const y = stack.pop()!;
      let x = stack.pop()!;
      const row = y * w;
      while (x >= 0 && !out[row + x] && matches((row + x) * 4)) x--;
      x++;
      let up = false, down = false;
      while (x < w && !out[row + x] && matches((row + x) * 4)) {
        out[row + x] = 1;
        if (y > 0) {
          const m = !out[row - w + x] && matches((row - w + x) * 4);
          if (m && !up) stack.push(x, y - 1);
          up = m;
        }
        if (y < h - 1) {
          const m = !out[row + w + x] && matches((row + w + x) * 4);
          if (m && !down) stack.push(x, y + 1);
          down = m;
        }
        x++;
      }
    }
  } else for (let i = 0; i < w * h; i++) if (matches(i * 4)) out[i] = 1;
  const mask = createCanvas(w, h);
  const mctx = ctx2d(mask);
  const img = mctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) if (out[i]) d[i * 4 + 3] = 255;
  if (opts.antialias) {
    // внешний край: частичная непрозрачность по числу выделенных соседей
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (out[i]) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && out[yy * w + xx]) n++;
          }
        if (n) d[i * 4 + 3] = Math.min(160, n * 28);
      }
  }
  mctx.putImageData(img, 0, 0);
  return mask;
}

/**
 * Маска пикселей, похожих по цвету на пиксель (sx, sy).
 * Возвращает canvas-маску (альфа 255 у отмеченных) или null вне границ.
 */
export function floodMask(src: HTMLCanvasElement, sx: number, sy: number, opts: FloodOptions): HTMLCanvasElement | null {
  const w = src.width, h = src.height;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const data = ctx2d(src).getImageData(0, 0, w, h).data;
  const si = (sy * w + sx) * 4;
  const r0 = data[si], g0 = data[si + 1], b0 = data[si + 2], a0 = data[si + 3];
  const tol = opts.tolerance;
  const matches = (i: number) => {
    const a = data[i + 3];
    // оба почти прозрачны — считаем одним цветом независимо от RGB
    if (a0 < 8 && a < 8) return true;
    if (Math.abs(a - a0) > tol) return false;
    return Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol && Math.abs(data[i + 2] - b0) <= tol;
  };
  const out = new Uint8Array(w * h);
  if (opts.contiguous) {
    // построчная заливка со стеком
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const y = stack.pop()!;
      let x = stack.pop()!;
      let row = y * w;
      while (x >= 0 && !out[row + x] && matches((row + x) * 4)) x--;
      x++;
      let up = false, down = false;
      while (x < w && !out[row + x] && matches((row + x) * 4)) {
        out[row + x] = 1;
        if (y > 0) {
          const m = !out[row - w + x] && matches((row - w + x) * 4);
          if (m && !up) stack.push(x, y - 1);
          up = m;
        }
        if (y < h - 1) {
          const m = !out[row + w + x] && matches((row + w + x) * 4);
          if (m && !down) stack.push(x, y + 1);
          down = m;
        }
        x++;
      }
      row = 0;
    }
  } else {
    for (let i = 0; i < w * h; i++) if (matches(i * 4)) out[i] = 1;
  }
  const mask = createCanvas(w, h);
  const mctx = ctx2d(mask);
  const img = mctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) if (out[i]) img.data[i * 4 + 3] = 255;
  mctx.putImageData(img, 0, 0);
  return mask;
}

/**
 * «Цветовой диапазон»: маска пикселей, близких к color по всему изображению.
 * tolerance — порог полного выделения, softness — ширина плавного перехода за ним.
 */
export function colorRangeMask(
  src: HTMLCanvasElement,
  color: [number, number, number, number],
  tolerance: number,
  softness: number,
): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const d = ctx2d(src).getImageData(0, 0, w, h).data;
  const mask = createCanvas(w, h);
  const mctx = ctx2d(mask);
  const img = mctx.createImageData(w, h);
  const [r0, g0, b0, a0] = color;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = d[o + 3];
    let dist: number;
    if (a0 < 8 && a < 8) dist = 0;
    else dist = Math.max(Math.abs(d[o] - r0), Math.abs(d[o + 1] - g0), Math.abs(d[o + 2] - b0), Math.abs(a - a0));
    let v = 0;
    if (dist <= tolerance) v = 255;
    else if (softness > 0 && dist < tolerance + softness) v = 255 * (1 - (dist - tolerance) / softness);
    img.data[o + 3] = v;
  }
  mctx.putImageData(img, 0, 0);
  return mask;
}
