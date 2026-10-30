import { create } from 'zustand';
import { alphaBounds, createCanvas, cropCanvas, ctx2d } from '../core/canvas';
import type { Doc } from '../core/doc';
import { hardenMask, maskedCopy, selectionFromMask } from '../core/selection';
import type { Point, Rect } from '../core/types';
import { drawQuadPreview, isConvex, pointInQuad, quadCenter, warpToQuad, type Quad } from '../core/warp';
import { toast } from '../store';
import { changed, editableLayer, infoLabel, requestRender, type PointerInfo, type Tool } from './base';

/**
 * Трансформация как в Photoshop: рамка из четырёх углов.
 *  - свободная: масштаб за ручки, поворот снаружи, перемещение внутри;
 *  - наклон: стороны сдвигаются вдоль себя;
 *  - искажение: каждый угол тянется свободно;
 *  - перспектива: соседний угол движется зеркально.
 * В свободном режиме: ⌘ — искажение угла / наклон стороны, ⌘⌥⇧ — перспектива.
 */
export type TransformMode = 'free' | 'skew' | 'distort' | 'perspective';

export const TRANSFORM_MODES: { id: TransformMode; label: string }[] = [
  { id: 'free', label: 'Свободная' },
  { id: 'skew', label: 'Наклон' },
  { id: 'distort', label: 'Искажение' },
  { id: 'perspective', label: 'Перспектива' },
];

export const useTransform = create<{ active: boolean; quad: Quad; mode: TransformMode; smooth: boolean }>(() => ({
  active: false,
  quad: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
  mode: 'free',
  smooth: true,
}));

interface Session {
  doc: Doc;
  layerId: string;
  src: HTMLCanvasElement;
  base: HTMLCanvasElement;
  hadSelection: boolean;
  original: Quad;
}

let ts: Session | null = null;

export const transformActive = () => !!ts;

const rectQuad = (r: Rect): Quad => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

export function startTransform(doc: Doc, mode: TransformMode = 'free'): boolean {
  if (ts) {
    useTransform.setState({ mode });
    return true;
  }
  const layer = editableLayer(doc);
  if (!layer) return false;
  const source = doc.editSource(layer);
  const float = doc.selection ? maskedCopy(source, doc.selection) : source;
  const region = alphaBounds(float) ?? (doc.selection ? doc.selection.bounds : null);
  if (!region) {
    toast('Слой пуст — нечего трансформировать', 'error');
    return false;
  }
  const src = cropCanvas(float, region);
  const base = createCanvas(doc.width, doc.height);
  if (doc.selection) {
    const b = ctx2d(base);
    b.drawImage(source, 0, 0);
    b.globalCompositeOperation = 'destination-out';
    b.drawImage(doc.selection.mask, 0, 0);
  }
  const quad = rectQuad(region);
  ts = { doc, layerId: layer.id, src, base, hadSelection: !!doc.selection, original: quad };
  useTransform.setState({ active: true, quad, mode });
  doc.preview = {
    layerId: layer.id,
    draw(ctx) {
      if (!ts) return;
      ctx.drawImage(ts.base, 0, 0);
      const { quad: q, smooth } = useTransform.getState();
      drawQuadPreview(ctx, ts.src, q, smooth);
    },
  };
  changed();
  return true;
}

export function setQuad(q: Quad) {
  useTransform.setState({ quad: q });
  requestRender();
}

export function commitTransform() {
  if (!ts) return;
  const { quad, smooth } = useTransform.getState();
  if (!isConvex(quad)) {
    toast('Рамка перекручена или вогнута — поправьте углы', 'error');
    return;
  }
  const s = ts;
  ts = null;
  useTransform.setState({ active: false });
  s.doc.preview = null;
  const result = warpToQuad(s.src, quad, s.doc.width, s.doc.height, smooth);
  const label = { free: 'Свободная трансформация', skew: 'Наклон', distort: 'Искажение', perspective: 'Перспектива' }[useTransform.getState().mode];
  s.doc.compound(label, s.layerId, (ctx) => {
    ctx.clearRect(0, 0, s.doc.width, s.doc.height);
    ctx.drawImage(s.base, 0, 0);
    ctx.drawImage(result, 0, 0);
  }, () => {
    if (s.hadSelection) {
      const m = createCanvas(s.doc.width, s.doc.height);
      ctx2d(m).drawImage(result, 0, 0);
      s.doc.selection = selectionFromMask(hardenMask(m, 0));
    }
  });
  changed();
}

export function cancelTransform() {
  if (!ts) return;
  ts.doc.preview = null;
  ts = null;
  useTransform.setState({ active: false });
  changed();
}

// ---------- геометрия ----------

const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Point, k: number) => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const len = (a: Point) => Math.hypot(a.x, a.y);
const norm = (a: Point) => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const rot = (p: Point, a: number) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Точки ручек: 0..3 — углы, 4..7 — середины сторон (верх, право, низ, лево). */
function handles(q: Quad): Point[] {
  return [q[0], q[1], q[2], q[3], mid(q[0], q[1]), mid(q[1], q[2]), mid(q[2], q[3]), mid(q[3], q[0])];
}

/** Угол верхней стороны — «поворот» рамки. */
export function quadAngle(q: Quad) {
  return Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x);
}

export function quadSize(q: Quad) {
  return { w: len(sub(q[1], q[0])), h: len(sub(q[3], q[0])) };
}

/** Аффинное преобразование всех углов: масштаб kx/ky в осях рамки относительно anchor, затем поворот. */
export function scaleQuad(q: Quad, anchor: Point, kx: number, ky: number, theta = quadAngle(q)): Quad {
  return q.map((c) => {
    const l = rot(sub(c, anchor), -theta);
    return add(anchor, rot({ x: l.x * kx, y: l.y * ky }, theta));
  }) as Quad;
}

export function rotateQuad(q: Quad, center: Point, a: number): Quad {
  return q.map((c) => add(center, rot(sub(c, center), a))) as Quad;
}

export function translateQuad(q: Quad, d: Point): Quad {
  return q.map((c) => add(c, d)) as Quad;
}

// ---------- взаимодействие ----------

type Drag =
  | { kind: 'move'; start: Point; orig: Quad }
  | { kind: 'rotate'; start: number; center: Point; orig: Quad }
  | { kind: 'handle'; index: number; start: Point; orig: Quad };

let drag: Drag | null = null;

function hit(p: PointerInfo, doc: Doc): { kind: 'handle'; index: number } | { kind: 'inside' } | { kind: 'outside' } {
  const q = useTransform.getState().quad;
  const v = doc.view;
  const hs = handles(q).map((h) => ({ x: v.panX + h.x * v.zoom, y: v.panY + h.y * v.zoom }));
  const i = hs.findIndex((h) => Math.hypot(h.x - p.sx, h.y - p.sy) < 7);
  if (i >= 0) return { kind: 'handle', index: i };
  return pointInQuad(q, p) ? { kind: 'inside' } : { kind: 'outside' };
}

/** Режим конкретного перетаскивания с учётом модификаторов (как в Photoshop). */
function effectiveMode(p: PointerInfo, index: number): TransformMode {
  const mode = useTransform.getState().mode;
  if (mode !== 'free') return mode;
  const corner = index < 4;
  if (p.meta && p.alt && p.shift && corner) return 'perspective';
  if (p.meta && !corner) return 'skew';
  if (p.meta) return 'distort';
  return 'free';
}

function dragHandle(d: Extract<Drag, { kind: 'handle' }>, p: PointerInfo) {
  const o = d.orig;
  const delta = sub(p, d.start);
  const mode = effectiveMode(p, d.index);
  const u = norm(sub(o[1], o[0])); // ось «ширины» рамки
  const vv = norm(sub(o[3], o[0])); // ось «высоты»
  const q = o.map((c) => ({ ...c })) as Quad;
  const i = d.index;
  if (mode === 'distort') {
    if (i < 4) q[i] = add(o[i], delta);
    else {
      const a = i - 4, b = (i - 3) % 4;
      q[a] = add(o[a], delta);
      q[b] = add(o[b], delta);
    }
    return setQuad(q);
  }
  if (mode === 'skew') {
    if (i >= 4) {
      // сторона едет вдоль самой себя
      const a = i - 4, b = (i - 3) % 4;
      const dir = norm(sub(o[b], o[a]));
      const shift = mul(dir, dot(delta, dir));
      q[a] = add(o[a], shift);
      q[b] = add(o[b], shift);
    } else {
      // угол — вдоль той оси, куда тянут сильнее
      const along = Math.abs(dot(delta, u)) >= Math.abs(dot(delta, vv)) ? u : vv;
      q[i] = add(o[i], mul(along, dot(delta, along)));
    }
    return setQuad(q);
  }
  if (mode === 'perspective') {
    if (i >= 4) return setQuad(q);
    const du = dot(delta, u), dv = dot(delta, vv);
    // напарник на той же горизонтальной (0↔1, 3↔2) или вертикальной (0↔3, 1↔2) стороне
    const horizontal = Math.abs(du) >= Math.abs(dv);
    const partner = horizontal ? [1, 0, 3, 2][i] : [3, 2, 1, 0][i];
    const shift = horizontal ? mul(u, du) : mul(vv, dv);
    q[i] = add(o[i], shift);
    q[partner] = sub(o[partner], shift);
    return setQuad(q);
  }
  // свободная: масштаб относительно противоположной ручки (⌥ — от центра)
  const hs = handles(o);
  const theta = quadAngle(o);
  const anchor = p.alt ? quadCenter(o) : hs[i < 4 ? (i + 2) % 4 : 4 + ((i - 4 + 2) % 4)];
  const hl = rot(sub(hs[i], anchor), -theta);
  const pl = rot(sub(p, anchor), -theta);
  let kx = Math.abs(hl.x) > 0.5 ? pl.x / hl.x : 1;
  let ky = Math.abs(hl.y) > 0.5 ? pl.y / hl.y : 1;
  if (i === 4 || i === 6) kx = 1;
  if (i === 5 || i === 7) ky = 1;
  if (i < 4 && p.shift) {
    const k = Math.max(Math.abs(kx), Math.abs(ky));
    kx = Math.sign(kx || 1) * k;
    ky = Math.sign(ky || 1) * k;
  }
  setQuad(scaleQuad(o, anchor, kx, ky, theta));
}

const CURSORS = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'];

export const transformTool: Tool = {
  cursor(p, doc) {
    if (!ts || !p) return 'default';
    const h = hit(p, doc);
    if (h.kind === 'inside') return 'move';
    if (h.kind === 'outside') return useTransform.getState().mode === 'free' || useTransform.getState().mode === 'skew' ? 'alias' : 'default';
    const m = effectiveMode(p, h.index);
    return m === 'free' ? CURSORS[h.index] : 'crosshair';
  },
  down(p, doc) {
    if (!ts) return;
    const orig = useTransform.getState().quad;
    const h = hit(p, doc);
    if (h.kind === 'inside') drag = { kind: 'move', start: { x: p.x, y: p.y }, orig };
    else if (h.kind === 'handle') drag = { kind: 'handle', index: h.index, start: { x: p.x, y: p.y }, orig };
    else {
      const mode = useTransform.getState().mode;
      if (mode !== 'free' && mode !== 'skew') return;
      const c = quadCenter(orig);
      drag = { kind: 'rotate', start: Math.atan2(p.y - c.y, p.x - c.x), center: c, orig };
    }
  },
  drag(p) {
    if (!ts || !drag) return;
    if (drag.kind === 'move') {
      let d = sub(p, drag.start);
      if (p.shift) d = Math.abs(d.x) > Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
      setQuad(translateQuad(drag.orig, { x: Math.round(d.x), y: Math.round(d.y) }));
    } else if (drag.kind === 'rotate') {
      let a = Math.atan2(p.y - drag.center.y, p.x - drag.center.x) - drag.start;
      if (p.shift) {
        // шаг 15° от исходного угла рамки
        const base = quadAngle(drag.orig);
        a = Math.round((base + a) / (Math.PI / 12)) * (Math.PI / 12) - base;
      }
      setQuad(rotateQuad(drag.orig, drag.center, a));
    } else dragHandle(drag, p);
  },
  up() {
    drag = null;
  },
  dblclick() {
    commitTransform();
  },
  key(e) {
    if (!ts) return false;
    if (e.key === 'Enter') commitTransform();
    else if (e.key === 'Escape') cancelTransform();
    else if (e.key.startsWith('Arrow')) {
      const st = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: { x: -st, y: 0 }, ArrowRight: { x: st, y: 0 }, ArrowUp: { x: 0, y: -st }, ArrowDown: { x: 0, y: st } }[e.key]!;
      setQuad(translateQuad(useTransform.getState().quad, d));
    } else return false;
    return true;
  },
  hidesSelection: () => !!ts,
  overlay(ctx, v) {
    if (!ts) return;
    const { quad, mode } = useTransform.getState();
    const sp = (p: Point) => ({ x: v.panX + p.x * v.zoom, y: v.panY + p.y * v.zoom });
    const pts = quad.map(sp);
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = isConvex(quad) ? '#1a73e8' : '#ef4444';
    ctx.lineWidth = 1;
    ctx.stroke();
    // сетка третей — видно, как искажается плоскость
    if (mode === 'perspective' || mode === 'distort') {
      ctx.strokeStyle = 'rgba(26,115,232,0.45)';
      ctx.beginPath();
      for (const k of [1 / 3, 2 / 3]) {
        const a = sp({ x: quad[0].x + (quad[1].x - quad[0].x) * k, y: quad[0].y + (quad[1].y - quad[0].y) * k });
        const b = sp({ x: quad[3].x + (quad[2].x - quad[3].x) * k, y: quad[3].y + (quad[2].y - quad[3].y) * k });
        const c = sp({ x: quad[0].x + (quad[3].x - quad[0].x) * k, y: quad[0].y + (quad[3].y - quad[0].y) * k });
        const d = sp({ x: quad[1].x + (quad[2].x - quad[1].x) * k, y: quad[1].y + (quad[2].y - quad[1].y) * k });
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1a73e8';
    for (const h of handles(quad).map(sp)) {
      ctx.fillRect(h.x - 3.5, h.y - 3.5, 7, 7);
      ctx.strokeRect(h.x - 3.5, h.y - 3.5, 7, 7);
    }
    const c = sp(quadCenter(quad));
    ctx.beginPath();
    ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    const { w, h } = quadSize(quad);
    const name = TRANSFORM_MODES.find((m) => m.id === mode)!.label;
    infoLabel(ctx, `${name}: ${Math.round(w)} × ${Math.round(h)}  ${Math.round((quadAngle(quad) * 180) / Math.PI)}°`, pts[2].x + 10, pts[2].y + 10);
  },
};

/** Сбросить рамку к исходному прямоугольнику. */
export function resetTransform() {
  if (ts) setQuad(ts.original);
}
