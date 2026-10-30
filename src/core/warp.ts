import { createCanvas, ctx2d } from './canvas';
import type { Point } from './types';

/** Четырёхугольник: левый верхний, правый верхний, правый нижний, левый нижний. */
export type Quad = [Point, Point, Point, Point];

/** Матрица 3×3 построчно: [a b c; d e f; g h 1]. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Проективное отображение единичного квадрата (u,v ∈ [0,1]) в четырёхугольник. */
export function squareToQuad(q: Quad): Mat3 {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-12) return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
  }
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

export function apply3(m: Mat3, x: number, y: number): Point {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

/** Четырёхугольник — параллелограмм (преобразование аффинное). */
export function isAffine(q: Quad, eps = 0.01) {
  return Math.abs(q[0].x - q[1].x + q[2].x - q[3].x) < eps && Math.abs(q[0].y - q[1].y + q[2].y - q[3].y) < eps;
}

/** Невыпуклый или «перекрученный» четырёхугольник даёт мусор — такие не применяем. */
export function isConvex(q: Quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return sign !== 0;
}

/**
 * Рисует src в четырёхугольник q. Параллелограмм — одной аффинной матрицей
 * (точно и быстро), иначе — сеткой треугольников (для превью).
 */
export function drawQuadPreview(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, q: Quad, smooth: boolean, grid = 14) {
  const W = src.width, H = src.height;
  ctx.save();
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  if (isAffine(q)) {
    ctx.transform((q[1].x - q[0].x) / W, (q[1].y - q[0].y) / W, (q[3].x - q[0].x) / H, (q[3].y - q[0].y) / H, q[0].x, q[0].y);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    return;
  }
  const m = squareToQuad(q);
  const pts: Point[][] = [];
  for (let j = 0; j <= grid; j++) {
    pts.push([]);
    for (let i = 0; i <= grid; i++) pts[j].push(apply3(m, i / grid, j / grid));
  }
  const tri = (s0: Point, s1: Point, s2: Point, d0: Point, d1: Point, d2: Point) => {
    // аффинная матрица, переводящая треугольник src в треугольник dst
    const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (Math.abs(den) < 1e-9) return;
    const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
    const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
    const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
    const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
    const e = d0.x - a * s0.x - c * s0.y;
    const f = d0.y - b * s0.x - d * s0.y;
    ctx.save();
    // слегка раздутый треугольник, чтобы между ячейками не было щелей
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
    const grow = (p: Point) => {
      const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / l) * 1.1, y: p.y + (dy / l) * 1.1 };
    };
    const [g0, g1, g2] = [grow(d0), grow(d1), grow(d2)];
    ctx.beginPath();
    ctx.moveTo(g0.x, g0.y);
    ctx.lineTo(g1.x, g1.y);
    ctx.lineTo(g2.x, g2.y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  };
  for (let j = 0; j < grid; j++)
    for (let i = 0; i < grid; i++) {
      const s00 = { x: (i / grid) * W, y: (j / grid) * H }, s10 = { x: ((i + 1) / grid) * W, y: (j / grid) * H };
      const s01 = { x: (i / grid) * W, y: ((j + 1) / grid) * H }, s11 = { x: ((i + 1) / grid) * W, y: ((j + 1) / grid) * H };
      tri(s00, s10, s11, pts[j][i], pts[j][i + 1], pts[j + 1][i + 1]);
      tri(s00, s11, s01, pts[j][i], pts[j + 1][i + 1], pts[j + 1][i]);
    }
  ctx.restore();
}

/**
 * Точная проективная пересборка: для каждого пикселя результата ищем точку
 * в исходнике (обратная гомография) и берём билинейно (или ближайший пиксель).
 */
export function warpToQuad(src: HTMLCanvasElement, q: Quad, outW: number, outH: number, smooth: boolean): HTMLCanvasElement {
  const out = createCanvas(outW, outH);
  if (isAffine(q)) {
    drawQuadPreview(ctx2d(out), src, q, smooth);
    return out;
  }
  const inv = invert3(squareToQuad(q));
  if (!inv) return out;
  const W = src.width, H = src.height;
  const sd = ctx2d(src).getImageData(0, 0, W, H).data;
  const x0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.x))));
  const x1 = Math.min(outW, Math.ceil(Math.max(...q.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.y))));
  const y1 = Math.min(outH, Math.ceil(Math.max(...q.map((p) => p.y))));
  if (x1 <= x0 || y1 <= y0) return out;
  const octx = ctx2d(out);
  const img = octx.createImageData(x1 - x0, y1 - y0);
  const od = img.data;
  const ow = x1 - x0;
  // премультиплицированная выборка — без тёмной каймы на краях прозрачности
  const sample = (fx: number, fy: number, o: number) => {
    if (!smooth) {
      const ix = Math.floor(fx + 0.5), iy = Math.floor(fy + 0.5);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
      const i = (iy * W + ix) * 4;
      od[o] = sd[i]; od[o + 1] = sd[i + 1]; od[o + 2] = sd[i + 2]; od[o + 3] = sd[i + 3];
      return;
    }
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = 0; k < 4; k++) {
      const px = ix + (k & 1), py = iy + (k >> 1);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const wgt = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty);
      const i = (py * W + px) * 4;
      const al = sd[i + 3] * wgt;
      r += sd[i] * al; g += sd[i + 1] * al; b += sd[i + 2] * al; a += al;
    }
    if (a <= 0) return;
    od[o] = r / a; od[o + 1] = g / a; od[o + 2] = b / a; od[o + 3] = a;
  };
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = apply3(inv, x + 0.5, y + 0.5);
      if (p.x < -0.001 || p.y < -0.001 || p.x > 1.001 || p.y > 1.001) continue;
      sample(p.x * W - 0.5, p.y * H - 0.5, ((y - y0) * ow + (x - x0)) * 4);
    }
  octx.putImageData(img, x0, y0);
  return out;
}

export function quadCenter(q: Quad): Point {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
}

export function pointInQuad(q: Quad, p: Point) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i], b = q[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
