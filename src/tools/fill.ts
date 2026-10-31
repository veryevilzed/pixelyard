import { create } from 'zustand';
import { createCanvas, ctx2d, rgbaToCss } from '../core/canvas';
import type { Doc } from '../core/doc';
import { floodMask } from '../core/flood';
import { tiled } from '../core/patterns';
import { compositeForView, nextZoom, toScreen, zoomAt } from '../core/render';
import { hardenMask, maskedCopy } from '../core/selection';
import type { Point, TextData } from '../core/types';
import { app, setBg, setFg, setOpts, toast } from '../store';
import { drawGradient, resolveStops } from '../core/gradient';
import { addTextLayer, drawTextLayout, layoutBitmap, layoutVector, textLayerAt, updateTextLayer, type TextLayout } from '../core/textLayer';
import { fontGlyphs, useFonts } from '../core/fontLibrary';
import type { RenderedFont } from '../core/bmfont';
import { changed, constrain45, editableLayer, infoLabel, requestRender, snapPoint, type Tool } from './base';
import { sampleColor } from './sample';

// ---------- заливка ----------

export const fillTool: Tool = {
  cursor: () => 'crosshair',
  down(p, doc) {
    if (p.alt) {
      const c = sampleColor(doc, p.x, p.y, app().opts.eyedropperMerged);
      if (c) setFg(c);
      return;
    }
    const layer = editableLayer(doc);
    if (!layer) return;
    const o = app().opts;
    const src = o.fillSampleMerged ? compositeForView(doc) : doc.editSource(layer);
    let mask = floodMask(src, p.x, p.y, { tolerance: o.fillTolerance, contiguous: o.fillContiguous });
    if (!mask) return;
    if (doc.selection) {
      const sel = doc.selection;
      // клик вне выделения ничего не делает, как в Photoshop
      if (ctx2d(sel.mask).getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data[3] < 128) return;
      const m = ctx2d(mask);
      m.globalCompositeOperation = 'destination-in';
      m.drawImage(sel.mask, 0, 0);
    }
    const fg = app().fg;
    const paint = createCanvas(doc.width, doc.height);
    const pc = ctx2d(paint);
    pc.drawImage(mask, 0, 0);
    pc.globalCompositeOperation = 'source-in';
    const pattern = o.fillSource === 'pattern' ? tiled(o.fillPattern ?? '', doc.width, doc.height) : null;
    if (pattern) pc.drawImage(pattern, 0, 0);
    else {
      pc.fillStyle = rgbaToCss(fg);
      pc.fillRect(0, 0, doc.width, doc.height);
    }
    mask = null;
    doc.pixelEdit(layer.id, null, 'Заливка', (ctx) => {
      ctx.globalAlpha = app().opts.brushOpacity / 100;
      ctx.globalCompositeOperation = o.fillMode === 'erase' ? 'destination-out' : 'source-over';
      ctx.drawImage(paint, 0, 0);
    });
    changed();
  },
};

// ---------- градиент ----------

let grad: { a: Point; b: Point; doc: Doc; layerId: string } | null = null;

function gradientCanvas(doc: Doc, a: Point, b: Point): HTMLCanvasElement {
  const o = app().opts;
  const st = resolveStops(o.gradientStops, app().fg, app().bg, o.gradientReverse);
  const c = createCanvas(doc.width, doc.height);
  drawGradient(ctx2d(c), doc.width, doc.height, a, b, o.gradientKind, st);
  return doc.selection ? maskedCopy(c, doc.selection) : c;
}

export const gradientTool: Tool = {
  cursor: () => 'crosshair',
  down(p, doc) {
    const layer = editableLayer(doc);
    if (!layer) return;
    const a = { x: p.x, y: p.y };
    grad = { a, b: a, doc, layerId: layer.id };
    doc.preview = {
      layerId: layer.id,
      draw(ctx, l) {
        ctx.drawImage(l.canvas, 0, 0);
        if (!grad || (grad.a.x === grad.b.x && grad.a.y === grad.b.y)) return;
        ctx.globalAlpha = app().opts.brushOpacity / 100;
        ctx.drawImage(gradientCanvas(doc, grad.a, grad.b), 0, 0);
      },
    };
  },
  drag(p) {
    if (!grad) return;
    grad.b = p.shift ? constrain45(grad.a, p) : { x: p.x, y: p.y };
    requestRender();
  },
  up() {
    if (!grad) return;
    const g = grad;
    grad = null;
    g.doc.preview = null;
    if (Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) < 1) return changed();
    const img = gradientCanvas(g.doc, g.a, g.b);
    g.doc.pixelEdit(g.layerId, null, 'Градиент', (ctx) => {
      ctx.globalAlpha = app().opts.brushOpacity / 100;
      ctx.drawImage(img, 0, 0);
    });
    changed();
  },
  deactivate(doc) {
    if (doc) doc.preview = null;
    grad = null;
  },
  overlay(ctx, v) {
    if (!grad) return;
    const a = toScreen(v, grad.a), b = toScreen(v, grad.b);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const pt of [a, b]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  },
};

// ---------- пипетка ----------

export const eyedropperTool: Tool = {
  cursor: () => 'crosshair',
  down(p, doc) {
    const c = sampleColor(doc, p.x, p.y, app().opts.eyedropperMerged);
    if (c) (p.alt ? setBg : setFg)(c);
  },
  drag(p, doc) {
    const c = sampleColor(doc, p.x, p.y, app().opts.eyedropperMerged);
    if (c) (p.alt ? setBg : setFg)(c);
  },
};

// ---------- фигуры ----------

let shape: { a: Point; b: Point; doc: Doc; layerId: string; alt: boolean; shift: boolean } | null = null;

function shapeRect(s: NonNullable<typeof shape>) {
  let w = s.b.x - s.a.x, h = s.b.y - s.a.y;
  if (s.shift) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m;
    h = Math.sign(h || 1) * m;
  }
  if (s.alt) return { x: s.a.x - Math.abs(w), y: s.a.y - Math.abs(h), w: Math.abs(w) * 2, h: Math.abs(h) * 2 };
  return { x: Math.min(s.a.x, s.a.x + w), y: Math.min(s.a.y, s.a.y + h), w: Math.abs(w), h: Math.abs(h) };
}

function shapeCanvas(s: NonNullable<typeof shape>): HTMLCanvasElement {
  const o = app().opts;
  const c = createCanvas(s.doc.width, s.doc.height);
  const ctx = ctx2d(c);
  const color = rgbaToCss(app().fg);
  ctx.fillStyle = color;
  ctx.strokeStyle = o.shapeStroke && o.shapeFill ? rgbaToCss(app().bg) : color;
  ctx.lineWidth = o.shapeStrokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const sw = o.shapeStrokeWidth;
  if (o.shapeKind === 'line') {
    const b = s.shift ? constrain45(s.a, s.b) : s.b;
    // нечётная толщина — центр линии в центре пикселя, чтобы она была резкой
    const off = sw % 2 ? 0.5 : 0;
    ctx.beginPath();
    ctx.moveTo(Math.round(s.a.x) + off, Math.round(s.a.y) + off);
    ctx.lineTo(Math.round(b.x) + off, Math.round(b.y) + off);
    ctx.stroke();
  } else {
    const r = shapeRect(s);
    ctx.beginPath();
    if (o.shapeKind === 'rect') {
      if (o.shapeRadius > 0) ctx.roundRect(r.x, r.y, r.w, r.h, o.shapeRadius);
      else ctx.rect(r.x, r.y, r.w, r.h);
    } else ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    if (o.shapeFill) ctx.fill();
    if (o.shapeStroke || !o.shapeFill) {
      // обводка внутрь фигуры
      ctx.save();
      ctx.clip();
      ctx.lineWidth = sw * 2;
      ctx.stroke();
      ctx.restore();
    }
  }
  if (!o.shapeAntialias) hardenMask(c);
  return s.doc.selection ? maskedCopy(c, s.doc.selection) : c;
}

const SHAPE_NAMES = { rect: 'Прямоугольник', ellipse: 'Эллипс', line: 'Линия', arrow: 'Стрелка' };

// ---------- стрелка (изгибается как кривая Безье) ----------

/**
 * Стрелка: протянуть — прямая; дальше её можно править за ручки начала, конца и изгиба
 * (контрольная точка квадратичной кривой). Enter или клик в стороне — готово, Esc — отмена.
 */
interface ArrowEdit {
  doc: Doc;
  layerId: string;
  a: Point;
  b: Point;
  c: Point;
  /** Изгиб задан вручную (иначе контрольная точка — середина отрезка). */
  bent: boolean;
  drag: 'a' | 'b' | 'c' | 'new' | null;
}
let arrow: ArrowEdit | null = null;

const qpt = (a: Point, c: Point, b: Point, t: number): Point => ({
  x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
  y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
});

/** Нарисовать стрелку: линия кривой + треугольные наконечники по касательной. */
function drawArrow(ctx: CanvasRenderingContext2D, e: ArrowEdit) {
  const o = app().opts;
  const sw = o.shapeStrokeWidth;
  const head = Math.max(8, sw * o.arrowHeadSize);
  const color = rgbaToCss(app().fg);
  // точки кривой — для обрезки линии под наконечники и касательных
  const N = 64;
  const pts = Array.from({ length: N + 1 }, (_, i) => qpt(e.a, e.c, e.b, i / N));
  const len = pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
  const cut = Math.min(head * 0.75, len / 2.2);
  const trim = (fromEnd: boolean) => {
    let acc = 0;
    for (let i = 1; i <= N; i++) {
      const p = fromEnd ? pts[N - i] : pts[i], q = fromEnd ? pts[N - i + 1] : pts[i - 1];
      acc += Math.hypot(p.x - q.x, p.y - q.y);
      if (acc >= cut) return fromEnd ? N - i : i;
    }
    return fromEnd ? 0 : N;
  };
  const both = o.arrowHeads === 'both';
  const i0 = both ? trim(false) : 0, i1 = trim(true);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = sw;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) (i === i0 ? ctx.moveTo(pts[i].x, pts[i].y) : ctx.lineTo(pts[i].x, pts[i].y));
  ctx.stroke();
  const tip = (p: Point, from: Point) => {
    const ang = Math.atan2(p.y - from.y, p.x - from.x);
    const w = head * 0.45;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - Math.cos(ang) * head + Math.cos(ang + Math.PI / 2) * w, p.y - Math.sin(ang) * head + Math.sin(ang + Math.PI / 2) * w);
    ctx.lineTo(p.x - Math.cos(ang) * head * 0.82, p.y - Math.sin(ang) * head * 0.82);
    ctx.lineTo(p.x - Math.cos(ang) * head - Math.cos(ang + Math.PI / 2) * w, p.y - Math.sin(ang) * head - Math.sin(ang + Math.PI / 2) * w);
    ctx.closePath();
    ctx.fill();
  };
  // касательная в конце кривой — направление от контрольной точки к концу
  tip(e.b, Math.hypot(e.b.x - e.c.x, e.b.y - e.c.y) > 0.5 ? e.c : e.a);
  if (both) tip(e.a, Math.hypot(e.a.x - e.c.x, e.a.y - e.c.y) > 0.5 ? e.c : e.b);
}

function arrowCanvas(e: ArrowEdit): HTMLCanvasElement {
  const c = createCanvas(e.doc.width, e.doc.height);
  drawArrow(ctx2d(c), e);
  if (!app().opts.shapeAntialias) hardenMask(c);
  return e.doc.selection ? maskedCopy(c, e.doc.selection) : c;
}

function arrowPreview(e: ArrowEdit) {
  e.doc.preview = {
    layerId: e.layerId,
    draw(ctx, l) {
      ctx.drawImage(l.canvas, 0, 0);
      ctx.drawImage(arrowCanvas(e), 0, 0);
    },
  };
}

export function commitArrow() {
  const e = arrow;
  arrow = null;
  if (!e) return;
  e.doc.preview = null;
  if (Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) < 2) return changed();
  const img = arrowCanvas(e);
  if (app().opts.shapeNewLayer) e.doc.addLayer(e.doc.makeLayer(e.doc.nextLayerName('Стрелка'), img), 'Стрелка');
  else e.doc.pixelEdit(e.layerId, null, 'Стрелка', (ctx) => ctx.drawImage(img, 0, 0));
  changed();
}

function cancelArrow() {
  if (arrow) arrow.doc.preview = null;
  arrow = null;
  changed();
}

const arrowHandles = (e: ArrowEdit): [ 'a' | 'b' | 'c', Point][] => [['a', e.a], ['b', e.b], ['c', e.c]];

const arrowTool: Tool = {
  cursor: (p, doc) => (p && arrow && arrow.doc === doc && arrowHandles(arrow).some(([, h]) => Math.hypot((h.x - p.x) * doc.view.zoom, (h.y - p.y) * doc.view.zoom) < 9) ? 'move' : 'crosshair'),
  down(p, doc) {
    // ручка существующей стрелки — правка
    if (arrow && arrow.doc === doc) {
      const hit = arrowHandles(arrow).find(([, h]) => Math.hypot((h.x - p.x) * doc.view.zoom, (h.y - p.y) * doc.view.zoom) < 9);
      if (hit) {
        arrow.drag = hit[0];
        return;
      }
      commitArrow();
    }
    const o = app().opts;
    const layer = o.shapeNewLayer ? doc.activeLayer : editableLayer(doc);
    if (!layer) return;
    const a = snapPoint(p, doc.view);
    arrow = { doc, layerId: layer.id, a, b: a, c: a, bent: false, drag: 'new' };
    arrowPreview(arrow);
  },
  drag(p, doc) {
    const e = arrow;
    if (!e?.drag) return;
    const sp = e.drag === 'c' ? { x: p.x, y: p.y } : snapPoint(p, doc.view);
    if (e.drag === 'new' || e.drag === 'b') e.b = e.drag === 'new' && p.shift ? constrain45(e.a, sp) : sp;
    if (e.drag === 'a') e.a = sp;
    if (e.drag === 'c') {
      e.c = sp;
      e.bent = true;
    }
    // пока изгиб не задан — контрольная точка посередине (стрелка прямая)
    if (!e.bent) e.c = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
    requestRender();
  },
  up() {
    if (!arrow) return;
    if (arrow.drag === 'new' && Math.hypot(arrow.b.x - arrow.a.x, arrow.b.y - arrow.a.y) < 2) return cancelArrow();
    arrow.drag = null;
    requestRender();
  },
  key(e) {
    if (!arrow) return false;
    if (e.key === 'Enter') commitArrow();
    else if (e.key === 'Escape') cancelArrow();
    else return false;
    return true;
  },
  deactivate() {
    commitArrow();
  },
  overlay(ctx, v) {
    const e = arrow;
    if (!e) return;
    const A = toScreen(v, e.a), B = toScreen(v, e.b), C = toScreen(v, e.c);
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(59,130,246,0.9)';
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(C.x, C.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [id, P] of [['a', A], ['b', B]] as const) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5;
      ctx.fillRect(P.x - 4.5, P.y - 4.5, 9, 9);
      ctx.strokeRect(P.x - 4.5, P.y - 4.5, 9, 9);
      void id;
    }
    ctx.beginPath();
    ctx.arc(C.x, C.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#3b82f6';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
    if (!e.drag) infoLabel(ctx, 'Тяните синюю точку — изгиб; Enter — готово, Esc — отмена', B.x + 12, B.y + 12);
  },
};

const isArrow = () => app().opts.shapeKind === 'arrow';

export const shapeTool: Tool = {
  cursor: (p, doc) => (isArrow() ? arrowTool.cursor!(p, doc) : 'crosshair'),
  key: (e, doc) => (isArrow() || arrow ? arrowTool.key!(e, doc) : false),
  down(p, doc) {
    if (isArrow()) return arrowTool.down!(p, doc);
    if (arrow) commitArrow();
    const o = app().opts;
    const layer = o.shapeNewLayer ? doc.activeLayer : editableLayer(doc);
    if (!layer) return;
    const a = snapPoint(p, doc.view);
    shape = { a, b: a, doc, layerId: layer.id, alt: p.alt, shift: p.shift };
    doc.preview = {
      layerId: layer.id,
      draw(ctx, l) {
        ctx.drawImage(l.canvas, 0, 0);
        if (shape) ctx.drawImage(shapeCanvas(shape), 0, 0);
      },
    };
  },
  drag(p, doc) {
    if (isArrow()) return arrowTool.drag!(p, doc);
    if (!shape) return;
    shape.b = snapPoint(p, doc.view);
    shape.alt = p.alt;
    shape.shift = p.shift;
    requestRender();
  },
  up(p, doc) {
    if (isArrow()) return arrowTool.up!(p, doc);
    if (!shape) return;
    const s = shape;
    shape = null;
    s.doc.preview = null;
    if (Math.abs(s.b.x - s.a.x) < 1 && Math.abs(s.b.y - s.a.y) < 1) return changed();
    const img = shapeCanvas(s);
    const kind = app().opts.shapeKind;
    if (app().opts.shapeNewLayer) {
      s.doc.addLayer(s.doc.makeLayer(s.doc.nextLayerName(SHAPE_NAMES[kind]), img), SHAPE_NAMES[kind]);
    } else {
      s.doc.pixelEdit(s.layerId, null, SHAPE_NAMES[kind], (ctx) => ctx.drawImage(img, 0, 0));
    }
    changed();
  },
  deactivate(doc) {
    commitArrow();
    if (doc) doc.preview = null;
    shape = null;
  },
  overlay(ctx, v, doc) {
    if (arrow) return arrowTool.overlay!(ctx, v, doc);
    if (!shape) return;
    const r = app().opts.shapeKind === 'line' ? null : shapeRect(shape);
    const b = toScreen(v, shape.b);
    const text = r ? `${Math.round(r.w)} × ${Math.round(r.h)}` : `${Math.round(Math.hypot(shape.b.x - shape.a.x, shape.b.y - shape.a.y))} px`;
    infoLabel(ctx, text, b.x + 10, b.y + 10);
  },
};

// ---------- текст ----------

type TextBox = { w: number; h: number } | null;

/** Набор текста: место, текст, рамка (абзацный текст) и слой, если правится существующий текстовый слой. */
export const useTextEdit = create<{ at: Point | null; value: string; layerId: string | null; box: TextBox }>(() => ({ at: null, value: '', layerId: null, box: null }));

/** id растрового шрифта, если в «Тексте» выбран BMFont (значение шрифта «bmfont:<id>»). */
export const bitmapFontId = (font = app().opts.textFont) => (font.startsWith('bmfont:') ? font.slice(7) : null);

/** Загруженные глифы выбранного растрового шрифта (null — векторный шрифт или ещё не загружен). */
export function activeBitmapFont(): RenderedFont | null {
  const bm = bitmapFontId();
  return bm ? useFonts.getState().fonts.find((x) => x.id === bm)?.font ?? null : null;
}

/** Текущие настройки инструмента → данные текстового слоя. */
export function textDataFromOpts(value: string, at: Point, box: TextBox = null): TextData {
  const o = app().opts;
  return {
    value,
    x: at.x,
    y: at.y,
    box,
    align: o.textAlign,
    valign: o.textVAlign,
    font: o.textFont,
    size: o.textSize,
    bold: o.textBold,
    italic: o.textItalic,
    antialias: o.textAntialias,
    color: app().fg,
    bmTint: o.textBmTint,
  };
}

/** Раскладка набираемого текста (по ней строится поле ввода и предпросмотр растрового шрифта). */
export function editLayout(): TextLayout | null {
  const { at, value, box } = useTextEdit.getState();
  if (!at) return null;
  const t = textDataFromOpts(value, at, box);
  const f = activeBitmapFont();
  return f ? layoutBitmap(t, f) : layoutVector(t);
}

/** Настройки инструмента из текстового слоя (при начале правки). */
function optsFromText(t: TextData) {
  setOpts({
    textFont: t.font,
    textSize: t.size,
    textBold: t.bold,
    textItalic: t.italic,
    textAntialias: t.antialias,
    textBmTint: t.bmTint,
    textAlign: t.align ?? 'left',
    textVAlign: t.valign ?? 'top',
  });
  setFg(t.color);
}

/** Начать правку текстового слоя: его пиксели прячутся, текст — в поле ввода. */
export function editTextLayer(doc: Doc, layerId: string) {
  const l = doc.getLayer(layerId);
  if (!l?.text) return;
  doc.activeLayerId = l.id;
  optsFromText(l.text);
  useTextEdit.setState({ at: { x: l.text.x, y: l.text.y }, value: l.text.value, layerId: l.id, box: l.text.box ?? null });
  doc.preview = { layerId: l.id, draw: () => {} };
  const bm = bitmapFontId(l.text.font);
  if (bm) void fontGlyphs(bm).then(() => requestRender());
  changed();
}

/** Отмена набора: текст слоя остаётся прежним. */
export function cancelText(doc: Doc) {
  const { layerId } = useTextEdit.getState();
  useTextEdit.setState({ at: null, value: '', layerId: null, box: null });
  if (layerId && doc.preview?.layerId === layerId) doc.preview = null;
  changed();
}

/** Время последнего завершения набора: клик, который завершил текст, не начинает новый. */
let lastCommit = 0;

export function commitText(doc: Doc) {
  const { at, value, layerId, box } = useTextEdit.getState();
  if (at) lastCommit = performance.now();
  useTextEdit.setState({ at: null, value: '', layerId: null, box: null });
  if (layerId && doc.preview?.layerId === layerId) doc.preview = null;
  if (!at) return changed();
  const done = (p: Promise<unknown>) => void p.then(changed, (e) => toast(e instanceof Error ? e.message : String(e), 'error'));
  if (layerId) {
    // пустой текст — слой удаляется (как в Photoshop)
    if (!value.trim()) {
      if (doc.layers.length > 1) doc.removeLayer(layerId);
      return changed();
    }
    return done(updateTextLayer(doc, layerId, textDataFromOpts(value, at, box)));
  }
  if (!value.trim()) return changed();
  done(addTextLayer(doc, textDataFromOpts(value, at, box)));
}

/** Поле ввода потеряло фокус: завершить набор, если фокус ушёл не в панель параметров и текст не двигают. */
export function textBlurred(doc: Doc) {
  setTimeout(() => {
    if (textDrag || !useTextEdit.getState().at) return;
    const a = document.activeElement;
    if (a?.closest('.optionsbar, .font-picker-pop, .text-editor-wrap')) return;
    commitText(doc);
  }, 0);
}

/** Сменились настройки «Текста» — применить к выбранному текстовому слою (если он не правится сейчас). */
export function applyTextOptsToLayer(doc: Doc | null) {
  if (!doc || useTextEdit.getState().at) return void (requestRender(), changed());
  const l = doc.activeLayer;
  if (!l?.text) return;
  const next = textDataFromOpts(l.text.value, { x: l.text.x, y: l.text.y }, l.text.box ?? null);
  const last = doc.undoStack[doc.undoStack.length - 1];
  // серия изменений (кегль колёсиком) — одна запись истории
  if (last?.label === 'Параметры текста' && last.after?.layers === doc.layers) doc.undo();
  void updateTextLayer(doc, l.id, next, 'Параметры текста').then(changed);
}

/**
 * Перетаскивание инструментом «Текст»:
 * new — рамка нового абзацного текста; layer — перенос текстового слоя (⇧ или ⌘);
 * edit — перенос набираемого текста (⇧ или ⌘ во время набора).
 */
let textDrag:
  | { kind: 'new'; a: Point; b: Point }
  | { kind: 'layer'; layerId: string; start: Point; dx: number; dy: number }
  | { kind: 'edit'; start: Point; orig: Point }
  | null = null;

export const textTool: Tool = {
  cursor: () => 'text',
  down(p, doc) {
    const editing = useTextEdit.getState();
    if (editing.at) {
      if (p.shift || p.meta) {
        textDrag = { kind: 'edit', start: { x: p.x, y: p.y }, orig: editing.at };
        return;
      }
      return commitText(doc);
    }
    // этот же клик только что завершил набор (поле ввода потеряло фокус) — новый текст не начинаем
    if (performance.now() - lastCommit < 400) return;
    const hit = textLayerAt(doc, p.x, p.y);
    if (hit && (p.shift || p.meta)) {
      // ⇧/⌘ + перетаскивание по тексту — переместить слой, а не править
      textDrag = { kind: 'layer', layerId: hit.id, start: { x: p.x, y: p.y }, dx: 0, dy: 0 };
      doc.activeLayerId = hit.id;
      doc.preview = { layerId: hit.id, draw: (ctx, l) => textDrag?.kind === 'layer' && ctx.drawImage(l.canvas, textDrag.dx, textDrag.dy) };
      return changed();
    }
    // клик по текстовому слою — правка его текста
    if (hit) return editTextLayer(doc, hit.id);
    textDrag = { kind: 'new', a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y } };
  },
  drag(p, doc) {
    if (!textDrag) return;
    if (textDrag.kind === 'new') textDrag.b = { x: p.x, y: p.y };
    else if (textDrag.kind === 'layer') {
      textDrag.dx = Math.round(p.x - textDrag.start.x);
      textDrag.dy = Math.round(p.y - textDrag.start.y);
      if (p.shift && p.meta) Math.abs(textDrag.dx) > Math.abs(textDrag.dy) ? (textDrag.dy = 0) : (textDrag.dx = 0);
    } else {
      const o = textDrag.orig;
      useTextEdit.setState({ at: { x: Math.round(o.x + p.x - textDrag.start.x), y: Math.round(o.y + p.y - textDrag.start.y) } });
    }
    void doc;
    requestRender();
  },
  up(_p, doc) {
    const d = textDrag;
    textDrag = null;
    if (!d) return;
    if (d.kind === 'new') {
      const z = doc.view.zoom;
      const x = Math.round(Math.min(d.a.x, d.b.x)), y = Math.round(Math.min(d.a.y, d.b.y));
      const w = Math.round(Math.abs(d.b.x - d.a.x)), h = Math.round(Math.abs(d.b.y - d.a.y));
      // протянули рамку — текст в рамке, просто клик — точечный текст
      const box = w * z > 8 && h * z > 8 ? { w, h } : null;
      useTextEdit.setState({ at: box ? { x, y } : { x: Math.round(d.a.x), y: Math.round(d.a.y) }, value: '', layerId: null, box });
      const bm = bitmapFontId();
      if (bm) void fontGlyphs(bm).then(() => requestRender());
      return changed();
    }
    if (d.kind === 'layer') {
      const l = doc.getLayer(d.layerId);
      doc.preview = null;
      if (l?.text && (d.dx || d.dy)) {
        void updateTextLayer(doc, l.id, { ...l.text, x: l.text.x + d.dx, y: l.text.y + d.dy }, 'Переместить текст').then(changed);
      }
      return changed();
    }
    // перенос во время набора закончен — вернуть фокус полю ввода
    useTextEdit.setState({ at: { ...useTextEdit.getState().at! } });
  },
  hover(p, doc) {
    hoverText = !useTextEdit.getState().at && !!textLayerAt(doc, p.x, p.y);
    hoverMove = (p.shift || p.meta) && (!!useTextEdit.getState().at || hoverText);
  },
  overlay(ctx, v) {
    if (textDrag?.kind === 'new') {
      const a = toScreen(v, textDrag.a), b = toScreen(v, textDrag.b);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = 4;
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
      ctx.restore();
      return;
    }
    // предпросмотр текста растровым шрифтом во время набора
    const { at, value } = useTextEdit.getState();
    const f = activeBitmapFont();
    if (!at || !value || !f) return;
    const L = editLayout();
    if (!L) return;
    ctx.save();
    ctx.translate(v.panX, v.panY);
    ctx.scale(v.zoom, v.zoom);
    drawTextLayout(ctx, textDataFromOpts(value, at, useTextEdit.getState().box), L, f);
    ctx.restore();
  },
  deactivate(doc) {
    if (doc && useTextEdit.getState().at) commitText(doc);
  },
};
let hoverText = false;
let hoverMove = false;
textTool.cursor = () => (textDrag?.kind === 'layer' || textDrag?.kind === 'edit' || hoverMove ? 'move' : hoverText ? 'pointer' : 'text');

// ---------- навигация ----------

let pan: { sx: number; sy: number; px: number; py: number } | null = null;

export const handTool: Tool = {
  cursor: () => (pan ? 'grabbing' : 'grab'),
  down(p, doc) {
    pan = { sx: p.sx, sy: p.sy, px: doc.view.panX, py: doc.view.panY };
  },
  drag(p, doc) {
    if (!pan) return;
    doc.view = { ...doc.view, panX: pan.px + p.sx - pan.sx, panY: pan.py + p.sy - pan.sy };
    requestRender();
  },
  up() {
    pan = null;
    changed();
  },
};

export const zoomTool: Tool = {
  cursor: (p) => (p?.alt ? 'zoom-out' : 'zoom-in'),
  down(p, doc) {
    doc.view = zoomAt(doc.view, nextZoom(doc.view.zoom, p.alt ? -1 : 1), p.sx, p.sy);
    changed();
  },
};
