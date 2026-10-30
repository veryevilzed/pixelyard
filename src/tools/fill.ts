import { create } from 'zustand';
import { createCanvas, ctx2d, rgbaToCss } from '../core/canvas';
import type { Doc } from '../core/doc';
import { floodMask } from '../core/flood';
import { tiled } from '../core/patterns';
import { compositeForView, nextZoom, toScreen, zoomAt } from '../core/render';
import { hardenMask, maskedCopy } from '../core/selection';
import type { Point, RGBA, TextData } from '../core/types';
import { app, setBg, setFg, setOpts, toast } from '../store';
import { addTextLayer, textLayerAt, updateTextLayer } from '../core/textLayer';
import { drawBitmapText, fontGlyphs, useFonts } from '../core/fontLibrary';
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
  let c0: RGBA = app().fg, c1: RGBA = o.gradientToTransparent ? [c0[0], c0[1], c0[2], 0] : app().bg;
  if (o.gradientReverse) [c0, c1] = [c1, c0];
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  const g = o.gradientKind === 'linear'
    ? ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    : ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)));
  g.addColorStop(0, rgbaToCss(c0));
  g.addColorStop(1, rgbaToCss(c1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, doc.width, doc.height);
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

const SHAPE_NAMES = { rect: 'Прямоугольник', ellipse: 'Эллипс', line: 'Линия' };

export const shapeTool: Tool = {
  cursor: () => 'crosshair',
  down(p, doc) {
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
    if (!shape) return;
    shape.b = snapPoint(p, doc.view);
    shape.alt = p.alt;
    shape.shift = p.shift;
    requestRender();
  },
  up() {
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
    if (doc) doc.preview = null;
    shape = null;
  },
  overlay(ctx, v) {
    if (!shape) return;
    const r = app().opts.shapeKind === 'line' ? null : shapeRect(shape);
    const b = toScreen(v, shape.b);
    const text = r ? `${Math.round(r.w)} × ${Math.round(r.h)}` : `${Math.round(Math.hypot(shape.b.x - shape.a.x, shape.b.y - shape.a.y))} px`;
    infoLabel(ctx, text, b.x + 10, b.y + 10);
  },
};

// ---------- текст ----------

/** Набор текста: место, текст и слой, если правится существующий текстовый слой. */
export const useTextEdit = create<{ at: Point | null; value: string; layerId: string | null }>(() => ({ at: null, value: '', layerId: null }));

/** id растрового шрифта, если в «Тексте» выбран BMFont (значение шрифта «bmfont:<id>»). */
export const bitmapFontId = (font = app().opts.textFont) => (font.startsWith('bmfont:') ? font.slice(7) : null);

export function textFont() {
  const o = app().opts;
  // для растрового шрифта поле ввода показывает системный шрифт, а сам текст — предпросмотр глифами
  const family = bitmapFontId() ? '-apple-system, sans-serif' : o.textFont;
  return `${o.textItalic ? 'italic ' : ''}${o.textBold ? 'bold ' : ''}${o.textSize}px ${family}`;
}

function bitmapOpts(f: RenderedFont) {
  const o = app().opts;
  return { scale: o.textSize / Math.max(1, f.size), letterSpacing: 0, tint: o.textBmTint ? app().fg : null, smooth: o.textAntialias };
}

/** Текущие настройки инструмента → данные текстового слоя. */
export function textDataFromOpts(value: string, at: Point): TextData {
  const o = app().opts;
  return { value, x: at.x, y: at.y, font: o.textFont, size: o.textSize, bold: o.textBold, italic: o.textItalic, antialias: o.textAntialias, color: app().fg, bmTint: o.textBmTint };
}

/** Настройки инструмента из текстового слоя (при начале правки). */
function optsFromText(t: TextData) {
  setOpts({ textFont: t.font, textSize: t.size, textBold: t.bold, textItalic: t.italic, textAntialias: t.antialias, textBmTint: t.bmTint });
  setFg(t.color);
}

/** Начать правку текстового слоя: его пиксели прячутся, текст — в поле ввода. */
export function editTextLayer(doc: Doc, layerId: string) {
  const l = doc.getLayer(layerId);
  if (!l?.text) return;
  doc.activeLayerId = l.id;
  optsFromText(l.text);
  useTextEdit.setState({ at: { x: l.text.x, y: l.text.y }, value: l.text.value, layerId: l.id });
  doc.preview = { layerId: l.id, draw: () => {} };
  const bm = bitmapFontId(l.text.font);
  if (bm) void fontGlyphs(bm).then(() => requestRender());
  changed();
}

/** Отмена набора: текст слоя остаётся прежним. */
export function cancelText(doc: Doc) {
  const { layerId } = useTextEdit.getState();
  useTextEdit.setState({ at: null, value: '', layerId: null });
  if (layerId && doc.preview?.layerId === layerId) doc.preview = null;
  changed();
}

/** Время последнего завершения набора: клик, который завершил текст, не начинает новый. */
let lastCommit = 0;

export function commitText(doc: Doc) {
  const { at, value, layerId } = useTextEdit.getState();
  if (at) lastCommit = performance.now();
  useTextEdit.setState({ at: null, value: '', layerId: null });
  if (layerId && doc.preview?.layerId === layerId) doc.preview = null;
  if (!at) return changed();
  const done = (p: Promise<unknown>) => void p.then(changed, (e) => toast(e instanceof Error ? e.message : String(e), 'error'));
  if (layerId) {
    // пустой текст — слой удаляется (как в Photoshop)
    if (!value.trim()) {
      if (doc.layers.length > 1) doc.removeLayer(layerId);
      return changed();
    }
    return done(updateTextLayer(doc, layerId, textDataFromOpts(value, at)));
  }
  if (!value.trim()) return changed();
  done(addTextLayer(doc, textDataFromOpts(value, at)));
}

/** Сменились настройки «Текста» — применить к выбранному текстовому слою (если он не правится сейчас). */
export function applyTextOptsToLayer(doc: Doc | null) {
  if (!doc || useTextEdit.getState().at) return requestRender();
  const l = doc.activeLayer;
  if (!l?.text) return;
  const next = textDataFromOpts(l.text.value, { x: l.text.x, y: l.text.y });
  const last = doc.undoStack[doc.undoStack.length - 1];
  // серия изменений (кегль колёсиком) — одна запись истории
  if (last?.label === 'Параметры текста' && last.after?.layers === doc.layers) doc.undo();
  void updateTextLayer(doc, l.id, next, 'Параметры текста').then(changed);
}

export const textTool: Tool = {
  cursor: () => 'text',
  down(p, doc) {
    if (useTextEdit.getState().at) return commitText(doc);
    // этот же клик только что завершил набор (поле ввода потеряло фокус) — новый текст не начинаем
    if (performance.now() - lastCommit < 400) return;
    // клик по текстовому слою — правка его текста
    const hit = textLayerAt(doc, p.x, p.y);
    if (hit) return editTextLayer(doc, hit.id);
    useTextEdit.setState({ at: { x: Math.round(p.x), y: Math.round(p.y) }, value: '', layerId: null });
    const bm = bitmapFontId();
    if (bm) void fontGlyphs(bm).then(() => requestRender());
  },
  hover(p, doc) {
    hoverText = !useTextEdit.getState().at && !!textLayerAt(doc, p.x, p.y);
  },
  overlay(ctx, v) {
    // предпросмотр текста растровым шрифтом во время набора
    const { at, value } = useTextEdit.getState();
    const bm = bitmapFontId();
    const f = bm ? useFonts.getState().fonts.find((x) => x.id === bm)?.font : null;
    if (!at || !value || !f) return;
    ctx.save();
    ctx.translate(v.panX + at.x * v.zoom, v.panY + at.y * v.zoom);
    ctx.scale(v.zoom, v.zoom);
    drawBitmapText(ctx, f, value, 0, 0, bitmapOpts(f));
    ctx.restore();
  },
  deactivate(doc) {
    if (doc && useTextEdit.getState().at) commitText(doc);
  },
};
let hoverText = false;
textTool.cursor = () => (hoverText ? 'pointer' : 'text');

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
