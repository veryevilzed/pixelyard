import { ctx2d, uid } from './canvas';
import type { Rect, Slice } from './types';

export interface GridOptions {
  mode: 'count' | 'size';
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  offsetX: number;
  offsetY: number;
  gapX: number;
  gapY: number;
  /** Не создавать слайсы для полностью прозрачных ячеек. */
  skipEmpty: boolean;
  prefix: string;
}

export function gridSlices(width: number, height: number, o: GridOptions, source?: HTMLCanvasElement): Slice[] {
  let cw: number, ch: number, cols: number, rows: number;
  const areaW = width - o.offsetX, areaH = height - o.offsetY;
  if (o.mode === 'count') {
    cols = Math.max(1, o.cols);
    rows = Math.max(1, o.rows);
    cw = Math.floor((areaW - o.gapX * (cols - 1)) / cols);
    ch = Math.floor((areaH - o.gapY * (rows - 1)) / rows);
  } else {
    cw = Math.max(1, o.cellW);
    ch = Math.max(1, o.cellH);
    cols = Math.max(1, Math.floor((areaW + o.gapX) / (cw + o.gapX)));
    rows = Math.max(1, Math.floor((areaH + o.gapY) / (ch + o.gapY)));
  }
  const alpha = source && o.skipEmpty ? ctx2d(source).getImageData(0, 0, width, height).data : null;
  const isEmpty = (r: Rect) => {
    if (!alpha) return false;
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) if (alpha[(y * width + x) * 4 + 3] > 0) return false;
    return true;
  };
  const out: Slice[] = [];
  let n = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const rect = { x: o.offsetX + c * (cw + o.gapX), y: o.offsetY + r * (ch + o.gapY), w: cw, h: ch };
      if (rect.x + rect.w > width || rect.y + rect.h > height || cw <= 0 || ch <= 0) continue;
      if (isEmpty(rect)) continue;
      out.push({ id: uid('sl'), name: `${o.prefix}${n++}`, ...rect, nine: null });
    }
  return out;
}

export interface AutoOptions {
  /** Порог альфы, выше которого пиксель считается частью объекта. */
  alphaThreshold: number;
  /** Объекты ближе этого расстояния объединяются (полезно для «рассыпанных» спрайтов). */
  mergeDistance: number;
  minSize: number;
  padding: number;
  prefix: string;
}

/** Ищет связные области непрозрачных пикселей и возвращает их рамки. */
export function autoSlices(src: HTMLCanvasElement, o: AutoOptions): Slice[] {
  const w = src.width, h = src.height;
  const d = ctx2d(src).getImageData(0, 0, w, h).data;
  const label = new Int32Array(w * h).fill(-1);
  const boxes: Rect[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || d[start * 4 + 3] <= o.alphaThreshold) continue;
    const id = boxes.length;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 8-связность, чтобы диагональные пиксели пиксель-арта не разваливались
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (label[j] === -1 && d[j * 4 + 3] > o.alphaThreshold) {
            label[j] = id;
            stack.push(j);
          }
        }
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  // объединяем близкие рамки, пока есть что объединять
  let merged = boxes;
  const g = o.mergeDistance;
  let changed = true;
  while (changed) {
    changed = false;
    const next: Rect[] = [];
    for (const b of merged) {
      const hit = next.find(
        (n) => b.x <= n.x + n.w + g && n.x <= b.x + b.w + g && b.y <= n.y + n.h + g && n.y <= b.y + b.h + g,
      );
      if (hit) {
        const x = Math.min(hit.x, b.x), y = Math.min(hit.y, b.y);
        hit.w = Math.max(hit.x + hit.w, b.x + b.w) - x;
        hit.h = Math.max(hit.y + hit.h, b.y + b.h) - y;
        hit.x = x;
        hit.y = y;
        changed = true;
      } else next.push({ ...b });
    }
    merged = next;
  }
  const result = merged
    .filter((b) => b.w >= o.minSize && b.h >= o.minSize)
    .map((b) => {
      const x = Math.max(0, b.x - o.padding), y = Math.max(0, b.y - o.padding);
      return { x, y, w: Math.min(w, b.x + b.w + o.padding) - x, h: Math.min(h, b.y + b.h + o.padding) - y };
    })
    // порядок чтения: сверху вниз, слева направо (строки с допуском по высоте)
    .sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y));
  return result.map((r, i) => ({ id: uid('sl'), name: `${o.prefix}${i}`, ...r, nine: null }));
}
