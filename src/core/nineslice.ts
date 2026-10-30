import { createCanvas, ctx2d } from './canvas';
import type { NineSlice } from './types';

/**
 * 9-slice: углы не масштабируются, края тянутся (или повторяются) по одной оси, центр — по обеим.
 */

export type NineMode = 'stretch' | 'tile';

/** Границы, ограниченные размером картинки (левая + правая не больше ширины). */
export function clampNine(n: NineSlice, w: number, h: number): NineSlice {
  const left = Math.max(0, Math.min(w, Math.round(n.left)));
  const right = Math.max(0, Math.min(w - left, Math.round(n.right)));
  const top = Math.max(0, Math.min(h, Math.round(n.top)));
  const bottom = Math.max(0, Math.min(h - top, Math.round(n.bottom)));
  return { left, top, right, bottom };
}

/** Рисует src в прямоугольник dw×dh по правилам 9-slice. */
export function drawNine(ctx: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }, n: NineSlice, dx: number, dy: number, dw: number, dh: number, mode: NineMode = 'stretch', center = true) {
  const W = src.width, H = src.height;
  const { left: l, top: t, right: r, bottom: b } = clampNine(n, W, H);
  // если цель меньше суммы углов — углы ужимаются пропорционально
  const kx = Math.min(1, dw / Math.max(1, l + r)), ky = Math.min(1, dh / Math.max(1, t + b));
  const L = l * kx, R = r * kx, T = t * ky, B = b * ky;
  const sx = [0, l, W - r, W], sy = [0, t, H - b, H];
  const tx = [dx, dx + L, dx + dw - R, dx + dw], ty = [dy, dy + T, dy + dh - B, dy + dh];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      if (row === 1 && col === 1 && !center) continue;
      const sw = sx[col + 1] - sx[col], sh = sy[row + 1] - sy[row];
      const tw = tx[col + 1] - tx[col], th = ty[row + 1] - ty[row];
      if (sw <= 0 || sh <= 0 || tw <= 0 || th <= 0) continue;
      const stretchX = col === 1, stretchY = row === 1;
      if (mode === 'tile' && (stretchX || stretchY)) {
        // повтор: шаг — исходный размер куска по тянущейся оси
        ctx.save();
        ctx.beginPath();
        ctx.rect(tx[col], ty[row], tw, th);
        ctx.clip();
        const stepX = stretchX ? sw : tw, stepY = stretchY ? sh : th;
        for (let y = ty[row]; y < ty[row] + th; y += stepY)
          for (let x = tx[col]; x < tx[col] + tw; x += stepX) ctx.drawImage(src, sx[col], sy[row], sw, sh, x, y, stepX, stepY);
        ctx.restore();
      } else ctx.drawImage(src, sx[col], sy[row], sw, sh, tx[col], ty[row], tw, th);
    }
}

export function renderNine(src: HTMLCanvasElement, n: NineSlice, w: number, h: number, mode: NineMode = 'stretch', smooth = true): HTMLCanvasElement {
  const c = createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = ctx2d(c);
  ctx.imageSmoothingEnabled = smooth;
  drawNine(ctx, src, n, 0, 0, c.width, c.height, mode);
  return c;
}

/**
 * Android 9-patch (.9.png): картинка в рамке 1 px; чёрные пиксели сверху/слева — растягиваемые
 * области, снизу/справа — область содержимого (здесь совпадает с растягиваемой).
 */
export function encodeNinePatchCanvas(src: HTMLCanvasElement, n: NineSlice): HTMLCanvasElement {
  const { left, top, right, bottom } = clampNine(n, src.width, src.height);
  const W = src.width, H = src.height;
  const c = createCanvas(W + 2, H + 2);
  const ctx = ctx2d(c);
  ctx.drawImage(src, 1, 1);
  ctx.fillStyle = '#000';
  const sw = Math.max(1, W - left - right), sh = Math.max(1, H - top - bottom);
  ctx.fillRect(1 + left, 0, sw, 1);
  ctx.fillRect(0, 1 + top, 1, sh);
  ctx.fillRect(1 + left, H + 1, sw, 1);
  ctx.fillRect(W + 1, 1 + top, 1, sh);
  return c;
}
