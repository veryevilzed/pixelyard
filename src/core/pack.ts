import { alphaBounds, createCanvas, cropCanvas, ctx2d } from './canvas';
import type { Rect } from './types';

/**
 * Упаковка спрайтов в атлас: MaxRects с пятью эвристиками, полки, сетка, перебор «наилучший»,
 * вращение на 90° и несколько страниц. Общий движок для атласов, спрайтшитов и растровых шрифтов.
 */

export type PackAlgorithm = 'best' | 'maxrects' | 'shelf' | 'grid';
export type PackHeuristic = 'short-side' | 'long-side' | 'area' | 'bottom-left' | 'contact';
export type PackSort = 'auto' | 'name' | 'area' | 'max-side' | 'height' | 'width' | 'none';
export type RotationDir = 'cw' | 'ccw';

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
  allowRotation?: boolean;
  algorithm?: PackAlgorithm;
  heuristic?: PackHeuristic;
  sort?: PackSort;
  /** Если не помещается на одну страницу — заводить следующие. */
  multipage?: boolean;
  /** Куда поворачивать спрайт в картинке атласа (зависит от формата). */
  rotationDir?: RotationDir;
}

export const DEFAULT_PACK: PackOptions = { maxSize: 2048, spacing: 2, border: 0, extrude: 0, pot: true, square: false };

export const ALGORITHMS: [PackAlgorithm, string][] = [
  ['best', 'Наилучший'],
  ['maxrects', 'MaxRects'],
  ['shelf', 'Полки (ряды)'],
  ['grid', 'Сетка'],
];
export const HEURISTICS: [PackHeuristic, string][] = [
  ['short-side', 'Короткая сторона'],
  ['long-side', 'Длинная сторона'],
  ['area', 'Площадь'],
  ['bottom-left', 'Снизу слева'],
  ['contact', 'Касание'],
];
export const SORTS: [PackSort, string][] = [
  ['auto', 'Авто (крупные первыми)'],
  ['name', 'По алфавиту'],
  ['area', 'По площади'],
  ['max-side', 'По длинной стороне'],
  ['height', 'По высоте'],
  ['width', 'По ширине'],
  ['none', 'Как в списке'],
];

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
  /** Запрет вращения именно этого спрайта. */
  noRotate?: boolean;
  /** Свой extrude (иначе общий). */
  extrude?: number;
}

export interface PackedFrame extends PackInput {
  /** Положение в атласе (без extrude): левый верхний угол занятой области. */
  x: number;
  y: number;
  /** Размер БЕЗ поворота; повёрнутый кадр занимает в атласе h×w. */
  w: number;
  h: number;
  trimmed: boolean;
  rotated: boolean;
  page: number;
  /** Индекс во входном списке. */
  index: number;
}

export interface PackPage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  frames: PackedFrame[];
}

export interface PackResult {
  pages: PackPage[];
  /** Все кадры всех страниц (в порядке входа). */
  frames: PackedFrame[];
  /** Первая страница — для простых случаев (шрифты, одностраничные листы). */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** Обрезка прозрачных полей: кадр + смещение внутри исходного. */
export function trimSprite(name: string, src: HTMLCanvasElement, trim: boolean, extra?: PackInput['extra']): PackInput | null {
  if (!trim) return { name, canvas: src, offX: 0, offY: 0, srcW: src.width, srcH: src.height, extra };
  const b = alphaBounds(src);
  if (!b) return null;
  return { name, canvas: cropCanvas(src, b), offX: b.x, offY: b.y, srcW: src.width, srcH: src.height, extra };
}

// ---------- раскладка (без картинок) ----------

/** Размер с учётом зазора и extrude. */
interface Box {
  w: number;
  h: number;
  rot: boolean;
}
interface Place {
  x: number;
  y: number;
  rot: boolean;
}
interface BinResult {
  places: (Place | null)[];
  usedW: number;
  usedH: number;
  /** Все ли из order размещены. */
  ok: boolean;
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const contains = (a: Rect, b: Rect) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

/** Длина общей границы отрезков [a0,a1] и [b0,b1]. */
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function maxRectsBin(boxes: Box[], order: number[], W: number, H: number, heur: PackHeuristic, rotate: boolean, skip: boolean): BinResult {
  let free: Rect[] = [{ x: 0, y: 0, w: W, h: H }];
  const used: Rect[] = [];
  const places: (Place | null)[] = new Array(boxes.length).fill(null);
  let usedW = 0, usedH = 0, ok = true;

  const contact = (x: number, y: number, w: number, h: number) => {
    let s = 0;
    if (x === 0 || x + w === W) s += h;
    if (y === 0 || y + h === H) s += w;
    for (const u of used) {
      if (u.x === x + w || u.x + u.w === x) s += overlap(u.y, u.y + u.h, y, y + h);
      if (u.y === y + h || u.y + u.h === y) s += overlap(u.x, u.x + u.w, x, x + w);
    }
    return s;
  };
  const score = (f: Rect, w: number, h: number): [number, number] => {
    const dw = f.w - w, dh = f.h - h;
    switch (heur) {
      case 'long-side': return [Math.max(dw, dh), Math.min(dw, dh)];
      case 'area': return [f.w * f.h - w * h, Math.min(dw, dh)];
      case 'bottom-left': return [f.y + h, f.x];
      case 'contact': return [-contact(f.x, f.y, w, h), f.y * W + f.x];
      default: return [Math.min(dw, dh), Math.max(dw, dh)];
    }
  };

  for (const i of order) {
    const b = boxes[i];
    let best: Place | null = null, bw = 0, bh = 0, s1 = Infinity, s2 = Infinity;
    for (const f of free) {
      for (const r of rotate && b.rot && b.w !== b.h ? [false, true] : [false]) {
        const w = r ? b.h : b.w, h = r ? b.w : b.h;
        if (w > f.w || h > f.h) continue;
        const [a, c] = score(f, w, h);
        if (a < s1 || (a === s1 && c < s2)) {
          best = { x: f.x, y: f.y, rot: r };
          bw = w;
          bh = h;
          s1 = a;
          s2 = c;
        }
      }
    }
    if (!best) {
      ok = false;
      if (skip) continue;
      break;
    }
    places[i] = best;
    const pr = { x: best.x, y: best.y, w: bw, h: bh };
    used.push(pr);
    usedW = Math.max(usedW, pr.x + pr.w);
    usedH = Math.max(usedH, pr.y + pr.h);
    // разрезаем свободные области, пересекающиеся с размещённым
    const kept: Rect[] = [], pieces: Rect[] = [];
    for (const f of free) {
      if (!intersects(f, pr)) {
        kept.push(f);
        continue;
      }
      if (pr.x > f.x) pieces.push({ x: f.x, y: f.y, w: pr.x - f.x, h: f.h });
      if (pr.x + pr.w < f.x + f.w) pieces.push({ x: pr.x + pr.w, y: f.y, w: f.x + f.w - pr.x - pr.w, h: f.h });
      if (pr.y > f.y) pieces.push({ x: f.x, y: f.y, w: f.w, h: pr.y - f.y });
      if (pr.y + pr.h < f.y + f.h) pieces.push({ x: f.x, y: pr.y + pr.h, w: f.w, h: f.y + f.h - pr.y - pr.h });
    }
    // старые области не могут лежать внутри новых кусков — проверяем только куски
    const fresh = pieces.filter((p, ip) => !kept.some((k) => contains(k, p)) && !pieces.some((q, iq) => iq !== ip && contains(q, p) && (iq < ip || !contains(p, q))));
    free = kept.concat(fresh);
  }
  return { places, usedW, usedH, ok };
}

/** Полки: ряды слева направо в заданном порядке. */
function shelfBin(boxes: Box[], order: number[], W: number, H: number, rotate: boolean, skip: boolean): BinResult {
  const places: (Place | null)[] = new Array(boxes.length).fill(null);
  let x = 0, y = 0, rowH = 0, usedW = 0, ok = true;
  for (const i of order) {
    const b = boxes[i];
    // в ряд выгоднее ставить «лёжа», если это не увеличивает высоту ряда
    let r = rotate && b.rot && b.h > b.w && b.w <= Math.max(rowH, 1) && b.h <= W - x;
    let w = r ? b.h : b.w, h = r ? b.w : b.h;
    if (x + w > W) {
      y += rowH;
      x = 0;
      rowH = 0;
      r = rotate && b.rot && b.w > W && b.h <= W;
      w = r ? b.h : b.w;
      h = r ? b.w : b.h;
    }
    if (w > W || y + h > H) {
      ok = false;
      if (skip) continue;
      break;
    }
    places[i] = { x, y, rot: r };
    x += w;
    rowH = Math.max(rowH, h);
    usedW = Math.max(usedW, x);
  }
  return { places, usedW, usedH: y + rowH, ok };
}

/** Сетка: одинаковые ячейки по самому большому спрайту. */
function gridBin(boxes: Box[], order: number[], W: number, H: number, skip: boolean): BinResult {
  const places: (Place | null)[] = new Array(boxes.length).fill(null);
  const cw = Math.max(1, ...order.map((i) => boxes[i].w)), ch = Math.max(1, ...order.map((i) => boxes[i].h));
  const cols = Math.max(1, Math.floor(W / cw));
  let n = 0, usedW = 0, usedH = 0, ok = true;
  for (const i of order) {
    const x = (n % cols) * cw, y = Math.floor(n / cols) * ch;
    if (cw > W || y + ch > H) {
      ok = false;
      if (skip) continue;
      break;
    }
    places[i] = { x, y, rot: false };
    usedW = Math.max(usedW, x + cw);
    usedH = Math.max(usedH, y + ch);
    n++;
  }
  return { places, usedW, usedH, ok };
}

interface Variant {
  algorithm: Exclude<PackAlgorithm, 'best'>;
  heuristic: PackHeuristic;
  sort: PackSort;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortOrder(items: PackInput[], boxes: Box[], idx: number[], sort: PackSort): number[] {
  const o = idx.slice();
  const area = (i: number) => boxes[i].w * boxes[i].h;
  const maxSide = (i: number) => Math.max(boxes[i].w, boxes[i].h);
  switch (sort) {
    case 'none': return o;
    case 'name': return o.sort((a, b) => collator.compare(items[a].name, items[b].name));
    case 'area': return o.sort((a, b) => area(b) - area(a));
    case 'max-side': return o.sort((a, b) => maxSide(b) - maxSide(a) || area(b) - area(a));
    case 'height': return o.sort((a, b) => boxes[b].h - boxes[a].h || boxes[b].w - boxes[a].w);
    case 'width': return o.sort((a, b) => boxes[b].w - boxes[a].w || boxes[b].h - boxes[a].h);
    default: return o.sort((a, b) => maxSide(b) - maxSide(a) || area(b) - area(a));
  }
}

const nextPot = (v: number) => {
  let p = 1;
  while (p < v) p *= 2;
  return p;
};

interface Layout {
  places: (Place | null)[];
  W: number;
  H: number;
}

/** Итоговый размер страницы по занятой области. */
function finalSize(usedW: number, usedH: number, o: PackOptions) {
  let W = Math.max(1, usedW - o.spacing + o.border * 2), H = Math.max(1, usedH - o.spacing + o.border * 2);
  if (o.pot) {
    W = nextPot(W);
    H = nextPot(H);
  }
  if (o.square) W = H = Math.max(W, H);
  return { W, H };
}

function runBin(v: Variant, boxes: Box[], order: number[], W: number, H: number, rotate: boolean, skip: boolean): BinResult {
  if (v.algorithm === 'shelf') return shelfBin(boxes, order, W, H, rotate, skip);
  if (v.algorithm === 'grid') return gridBin(boxes, order, W, H, skip);
  return maxRectsBin(boxes, order, W, H, v.heuristic, rotate, skip);
}

/**
 * Минимальная страница для набора: перебираем ширины, для каждой — высоты от «площадь / ширина» вверх
 * до первой подошедшей. null — не помещается в inner×inner.
 */
function fitOne(v: Variant, boxes: Box[], order: number[], inner: number, rotate: boolean, o: PackOptions, coarse: boolean): Layout | null {
  if (!order.length) return { places: new Array(boxes.length).fill(null), W: 1, H: 1 };
  const area = order.reduce((s, i) => s + boxes[i].w * boxes[i].h, 0);
  const minSide = Math.max(...order.map((i) => (rotate && boxes[i].rot ? Math.min(boxes[i].w, boxes[i].h) : boxes[i].w)));
  const lo = Math.min(inner, Math.max(minSide, Math.floor(Math.sqrt(area) * 0.6)));
  const hi = Math.min(inner, Math.max(lo, Math.ceil(Math.sqrt(area) * 1.8)));
  const widths: number[] = [];
  if (o.pot) {
    // ширина контейнера, при которой страница с рамкой — ровно степень двойки
    for (let P = nextPot(lo); P <= hi * 2 && P - o.border * 2 + o.spacing <= inner; P *= 2) widths.push(P - o.border * 2 + o.spacing);
    if (!widths.length) widths.push(inner);
  } else {
    const step = coarse ? 1.15 : 1.07;
    for (let w = lo; w < hi; w = Math.ceil(w * step) + 1) widths.push(w);
    widths.push(hi);
  }
  if (o.square) {
    // квадрат: высота = ширина, перебор только по стороне
    for (const s of widths) {
      const r = runBin(v, boxes, order, s, s, rotate, false);
      if (r.ok) return { places: r.places, ...finalSize(r.usedW, r.usedH, o) };
    }
    const r = runBin(v, boxes, order, inner, inner, rotate, false);
    return r.ok ? { places: r.places, ...finalSize(r.usedW, r.usedH, o) } : null;
  }
  // высота: от площади вверх — укладка в «высокий» контейнер сама жмётся в узкую колонку
  const minH = Math.max(...order.map((i) => (rotate && boxes[i].rot ? Math.min(boxes[i].w, boxes[i].h) : boxes[i].h)));
  let best: Layout | null = null;
  for (const w of widths) {
    const heights: number[] = [];
    const h0 = Math.max(minH, Math.ceil(area / w));
    if (h0 > inner) continue;
    if (o.pot) {
      // контейнер, который после рамки даёт ровно степень двойки
      for (let P = nextPot(h0 + o.border * 2 - o.spacing); P - o.border * 2 + o.spacing <= inner * 2; P *= 2) heights.push(Math.min(inner, P - o.border * 2 + o.spacing));
    } else for (let h = h0; ; h = Math.ceil(h * (coarse ? 1.08 : 1.04)) + 1) {
      heights.push(Math.min(h, inner));
      if (h >= inner) break;
    }
    for (const h of [...new Set(heights)]) {
      if (best && pageCost(w, h) > pageCost(best.W, best.H) * 1.02) break;
      const r = runBin(v, boxes, order, w, h, rotate, false);
      if (!r.ok) continue;
      const cand: Layout = { places: r.places, ...finalSize(r.usedW, r.usedH, o) };
      if (!best || pageCost(cand.W, cand.H) < pageCost(best.W, best.H)) best = cand;
      break;
    }
  }
  if (!best) {
    const r = runBin(v, boxes, order, inner, inner, rotate, false);
    if (r.ok) best = { places: r.places, ...finalSize(r.usedW, r.usedH, o) };
  }
  return best;
}

/** Площадь со штрафом за вытянутость: при равной плотности лучше страница ближе к квадрату. */
const pageCost = (W: number, H: number) => W * H * (1 + 0.12 * (Math.max(W, H) / Math.min(W, H) - 1));

interface PageLayout extends Layout {
  items: number[];
}

/** Раскладка одним вариантом: одна страница или несколько. */
function layoutVariant(v: Variant, items: PackInput[], boxes: Box[], idx: number[], inner: number, rotate: boolean, o: PackOptions, coarse: boolean): PageLayout[] | null {
  const order = sortOrder(items, boxes, idx, v.sort);
  const one = fitOne(v, boxes, order, inner, rotate, o, coarse);
  if (one) return [{ ...one, items: order }];
  if (!o.multipage) return null;
  const pages: PageLayout[] = [];
  let rest = order;
  while (rest.length) {
    const r = runBin(v, boxes, rest, inner, inner, rotate, true);
    const on = rest.filter((i) => r.places[i]);
    if (!on.length) return null;
    // страницу ещё раз ужимаем до минимума (особенно важно для последней)
    const fit = fitOne(v, boxes, on, inner, rotate, o, coarse) ?? { places: r.places, ...finalSize(r.usedW, r.usedH, o) };
    pages.push({ ...fit, items: on });
    rest = rest.filter((i) => !r.places[i]);
  }
  return pages;
}

const cost = (p: PageLayout[]) => p.reduce((s, x) => s + pageCost(x.W, x.H), 0);

function variants(o: PackOptions): Variant[] {
  const algorithm = o.algorithm ?? 'maxrects';
  const heuristic = o.heuristic ?? 'short-side';
  const sort = o.sort ?? 'auto';
  if (algorithm !== 'best') return [{ algorithm, heuristic, sort }];
  const list: Variant[] = [];
  for (const h of HEURISTICS.map(([k]) => k))
    for (const s of ['auto', 'area', 'height'] as PackSort[]) list.push({ algorithm: 'maxrects', heuristic: h, sort: s });
  list.push({ algorithm: 'shelf', heuristic, sort: 'height' });
  return list;
}

// ---------- картинки ----------

/** Поворот на 90°: cw — по часовой, ccw — против. */
export function rotateCanvas(src: HTMLCanvasElement, dir: RotationDir): HTMLCanvasElement {
  const c = createCanvas(src.height, src.width);
  const ctx = ctx2d(c);
  if (dir === 'cw') {
    ctx.translate(src.height, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, src.width);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(src, 0, 0);
  return c;
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

// ---------- упаковка ----------

/** Упаковывает спрайты на одну или несколько страниц; бросает ошибку, если не помещается. */
export function packPages(items: PackInput[], o: PackOptions): PackResult {
  const rotate = !!o.allowRotation && o.algorithm !== 'grid';
  // пустой кадр (например, пробел в шрифте) места в атласе не занимает
  const empty = (it: PackInput) => it.srcW === 0 || it.srcH === 0 || it.canvas.width === 0 || it.canvas.height === 0;
  const ext = (it: PackInput) => Math.max(0, it.extrude ?? o.extrude);
  const boxes: Box[] = items.map((it) => {
    const pad = o.spacing + ext(it) * 2;
    return { w: it.canvas.width + pad, h: it.canvas.height + pad, rot: !it.noRotate };
  });
  const inner = o.maxSize - o.border * 2 + o.spacing; // последний зазор у края не нужен
  const idx = items.map((_, i) => i).filter((i) => !empty(items[i]));
  for (const i of idx) {
    const b = boxes[i];
    // страница квадратная (maxSize×maxSize), так что поворот здесь не помогает
    if (b.w > inner || b.h > inner) throw new Error(`Спрайт «${items[i].name}» (${items[i].canvas.width}×${items[i].canvas.height}) больше максимального размера атласа ${o.maxSize}px`);
  }

  const vs = variants(o);
  const coarse = vs.length > 1 && idx.length > 60;
  let best: PageLayout[] | null = null;
  for (const v of vs) {
    const r = layoutVariant(v, items, boxes, idx, inner, rotate, o, coarse);
    if (r && (!best || r.length < best.length || (r.length === best.length && cost(r) < cost(best)))) best = r;
  }
  if (!best) throw new Error(`Спрайты не помещаются в атлас ${o.maxSize}×${o.maxSize} — включите несколько страниц, увеличьте размер или уменьшите масштаб`);

  const dir = o.rotationDir ?? 'cw';
  const frames: PackedFrame[] = items.map((it, i) => ({ ...it, x: 0, y: 0, w: 0, h: 0, trimmed: false, rotated: false, page: 0, index: i }));
  const pages: PackPage[] = best.map((pl, pi) => {
    const canvas = createCanvas(pl.W, pl.H);
    const ctx = ctx2d(canvas);
    const list: PackedFrame[] = [];
    for (const i of pl.items) {
      const it = items[i], p = pl.places[i]!, e = ext(it);
      const x = p.x + o.border + e, y = p.y + o.border + e;
      const img = p.rot ? rotateCanvas(it.canvas, dir) : it.canvas;
      ctx.drawImage(img, x, y);
      if (e > 0) extrude(ctx, img, x, y, e);
      const w = it.canvas.width, h = it.canvas.height;
      frames[i] = { ...it, x, y, w, h, trimmed: w !== it.srcW || h !== it.srcH, rotated: p.rot, page: pi, index: i };
      list.push(frames[i]);
    }
    return { canvas, width: pl.W, height: pl.H, frames: list };
  });
  // пустые кадры — на первую страницу (нулевого размера)
  for (const f of frames) if (f.w === 0) pages[0].frames.push(f);
  pages.forEach((p) => p.frames.sort((a, b) => a.index - b.index));
  return { pages, frames, canvas: pages[0].canvas, width: pages[0].width, height: pages[0].height };
}

/** Упаковка на одну страницу (BMFont, простой спрайтшит). */
export function pack(items: PackInput[], o: PackOptions): PackResult {
  return packPages(items, { ...o, multipage: false });
}
