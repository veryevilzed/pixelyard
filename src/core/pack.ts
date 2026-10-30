import { alphaBounds, createCanvas, cropCanvas, ctx2d } from './canvas';
import type { Rect } from './types';

/**
 * Упаковка спрайтов в атлас (MaxRects, эвристика «лучшее короткое плечо»).
 * Общий движок для спрайтшитов и растровых шрифтов.
 */

export interface PackOptions {
  maxSize: number;
  /** Зазор между спрайтами. */
  spacing: number;
  /** Отступ от края атласа. */
  border: number;
  /** Дублирование краевых пикселей наружу — против швов при фильтрации в движках. */
  extrude: number;
  pot: boolean;
  square: boolean;
}

export const DEFAULT_PACK: PackOptions = { maxSize: 2048, spacing: 2, border: 0, extrude: 0, pot: true, square: false };

export interface PackInput {
  name: string;
  /** Уже обрезанное (или нет) изображение спрайта. */
  canvas: HTMLCanvasElement;
  /** Положение обрезанной части внутри исходного кадра. */
  offX: number;
  offY: number;
  srcW: number;
  srcH: number;
  /** Любые дополнительные данные (например, метрики глифа). */
  extra?: Record<string, number | string>;
}

export interface PackedFrame extends PackInput {
  /** Положение в атласе (без extrude). */
  x: number;
  y: number;
  w: number;
  h: number;
  trimmed: boolean;
}

export interface PackResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  frames: PackedFrame[];
}

/** Обрезка прозрачных полей: кадр + смещение внутри исходного. */
export function trimSprite(name: string, src: HTMLCanvasElement, trim: boolean, extra?: PackInput['extra']): PackInput | null {
  if (!trim) return { name, canvas: src, offX: 0, offY: 0, srcW: src.width, srcH: src.height, extra };
  const b = alphaBounds(src);
  if (!b) return null;
  return { name, canvas: cropCanvas(src, b), offX: b.x, offY: b.y, srcW: src.width, srcH: src.height, extra };
}

interface Free extends Rect {}

function maxRects(sizes: { w: number; h: number }[], binW: number, binH: number): (Rect | null)[] | null {
  let free: Free[] = [{ x: 0, y: 0, w: binW, h: binH }];
  const placed: (Rect | null)[] = new Array(sizes.length).fill(null);
  // крупные — первыми: так плотность заметно выше
  const order = sizes.map((_, i) => i).sort((a, b) => Math.max(sizes[b].w, sizes[b].h) - Math.max(sizes[a].w, sizes[a].h) || sizes[b].w * sizes[b].h - sizes[a].w * sizes[a].h);
  for (const i of order) {
    const { w, h } = sizes[i];
    if (w === 0 || h === 0) {
      placed[i] = { x: 0, y: 0, w: 0, h: 0 };
      continue;
    }
    let best: Rect | null = null, bestShort = Infinity, bestLong = Infinity;
    for (const f of free) {
      if (w <= f.w && h <= f.h) {
        const dw = f.w - w, dh = f.h - h;
        const s = Math.min(dw, dh), l = Math.max(dw, dh);
        if (s < bestShort || (s === bestShort && l < bestLong)) {
          best = { x: f.x, y: f.y, w, h };
          bestShort = s;
          bestLong = l;
        }
      }
    }
    if (!best) return null;
    placed[i] = best;
    // разрезаем свободные области, пересекающиеся с размещённым
    const next: Free[] = [];
    for (const f of free) {
      if (best.x >= f.x + f.w || best.x + best.w <= f.x || best.y >= f.y + f.h || best.y + best.h <= f.y) {
        next.push(f);
        continue;
      }
      if (best.x > f.x) next.push({ x: f.x, y: f.y, w: best.x - f.x, h: f.h });
      if (best.x + best.w < f.x + f.w) next.push({ x: best.x + best.w, y: f.y, w: f.x + f.w - best.x - best.w, h: f.h });
      if (best.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: best.y - f.y });
      if (best.y + best.h < f.y + f.h) next.push({ x: f.x, y: best.y + best.h, w: f.w, h: f.y + f.h - best.y - best.h });
    }
    // убираем области, целиком вложенные в другие
    free = next.filter((a, ia) => !next.some((b, ib) => ia !== ib && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (ia > ib || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y)));
  }
  return placed;
}

const nextPot = (v: number) => {
  let p = 1;
  while (p < v) p *= 2;
  return p;
};

/** Упаковывает спрайты; бросает ошибку, если не помещается в maxSize. */
export function pack(items: PackInput[], o: PackOptions): PackResult {
  const pad = o.spacing + o.extrude * 2;
  // пустой кадр (например, пробел в шрифте) места в атласе не занимает
  const empty = (it: PackInput) => it.srcW === 0 || it.srcH === 0;
  const sizes = items.map((it) => (empty(it) ? { w: 0, h: 0 } : { w: it.canvas.width + pad, h: it.canvas.height + pad }));
  const inner = o.maxSize - o.border * 2 + o.spacing; // последний зазор у края не нужен
  const area = sizes.reduce((s, z) => s + z.w * z.h, 0);
  const maxW = Math.max(1, ...sizes.map((z) => z.w));
  const maxH = Math.max(1, ...sizes.map((z) => z.h));
  if (maxW > inner || maxH > inner) throw new Error(`Спрайт больше максимального размера атласа ${o.maxSize}px`);
  // перебираем размеры от минимально возможного — первый подошедший и берём
  const candidates: { w: number; h: number }[] = [];
  let side = Math.max(maxW, maxH, Math.ceil(Math.sqrt(area)));
  for (let guard = 0; guard < 64; guard++) {
    const w = o.pot ? nextPot(side) : side;
    for (const h of o.square ? [w] : [Math.max(maxH, Math.ceil(area / w)), w]) {
      const hh = o.pot ? nextPot(h) : h;
      if (w <= inner && hh <= inner && !candidates.some((c) => c.w === w && c.h === hh)) candidates.push({ w, h: hh });
    }
    if (side >= inner) break;
    side = o.pot ? nextPot(side) * 2 : Math.ceil(side * 1.08) + 1;
    side = Math.min(side, inner);
  }
  candidates.sort((a, b) => a.w * a.h - b.w * b.h || Math.max(a.w, a.h) - Math.max(b.w, b.h));
  for (const c of candidates) {
    const placed = maxRects(sizes, c.w, c.h);
    if (!placed) continue;
    // реальный занятый размер (без хвостов), затем снова до степени двойки
    let usedW = 0, usedH = 0;
    placed.forEach((r) => {
      if (!r) return;
      usedW = Math.max(usedW, r.x + r.w - o.spacing);
      usedH = Math.max(usedH, r.y + r.h - o.spacing);
    });
    let W = Math.max(1, usedW + o.border * 2), H = Math.max(1, usedH + o.border * 2);
    if (o.pot) {
      W = nextPot(W);
      H = nextPot(H);
    }
    if (o.square) W = H = Math.max(W, H);
    const canvas = createCanvas(W, H);
    const ctx = ctx2d(canvas);
    const frames: PackedFrame[] = items.map((it, i) => {
      const r = placed[i]!;
      const x = r.x + o.border + o.extrude, y = r.y + o.border + o.extrude;
      const w = empty(it) ? 0 : it.canvas.width, h = empty(it) ? 0 : it.canvas.height;
      if (w && h) {
        ctx.drawImage(it.canvas, x, y);
        if (o.extrude > 0) extrude(ctx, it.canvas, x, y, o.extrude);
      }
      return { ...it, x: w ? x : 0, y: h ? y : 0, w, h, trimmed: w !== it.srcW || h !== it.srcH };
    });
    return { canvas, width: W, height: H, frames };
  }
  throw new Error(`Спрайты не помещаются в атлас ${o.maxSize}×${o.maxSize} — увеличьте максимальный размер или уменьшите масштаб`);
}

/** Растягивает крайние ряды пикселей наружу на n px. */
function extrude(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, n: number) {
  const w = src.width, h = src.height;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, w, 1, x, y - n, w, n); // верх
  ctx.drawImage(src, 0, h - 1, w, 1, x, y + h, w, n); // низ
  ctx.drawImage(src, 0, 0, 1, h, x - n, y, n, h); // лево
  ctx.drawImage(src, w - 1, 0, 1, h, x + w, y, n, h); // право
  ctx.drawImage(src, 0, 0, 1, 1, x - n, y - n, n, n);
  ctx.drawImage(src, w - 1, 0, 1, 1, x + w, y - n, n, n);
  ctx.drawImage(src, 0, h - 1, 1, 1, x - n, y + h, n, n);
  ctx.drawImage(src, w - 1, h - 1, 1, 1, x + w, y + h, n, n);
  ctx.imageSmoothingEnabled = true;
}
