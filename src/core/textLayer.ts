import { alphaBounds, createCanvas, ctx2d, rgbaToCss } from './canvas';
import type { Doc } from './doc';
import { drawBitmapText, fontGlyphs } from './fontLibrary';
import { hardenMask } from './selection';
import type { Layer, RGBA, TextData } from './types';

/**
 * Текстовые слои: в слое хранится TextData, пиксели строятся из неё заново при каждой правке.
 * Растрирование убирает TextData — дальше слой обычный.
 */

export const isTextLayer = (l: Layer | null | undefined): l is Layer & { text: TextData } => !!l?.text;

const bitmapId = (font: string) => (font.startsWith('bmfont:') ? font.slice(7) : null);

export function textCss(t: TextData) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.size}px ${t.font}`;
}

/** Пиксели текста на холсте размером с документ. */
export async function renderTextCanvas(t: TextData, w: number, h: number): Promise<HTMLCanvasElement> {
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  const bm = bitmapId(t.font);
  if (bm) {
    const f = await fontGlyphs(bm);
    if (!f) throw new Error('Растровый шрифт этого слоя не найден в библиотеке (меню «Шрифт»)');
    drawBitmapText(ctx, f, t.value, t.x, t.y, { scale: t.size / Math.max(1, f.size), letterSpacing: 0, tint: t.bmTint ? t.color : null, smooth: t.antialias });
    return c;
  }
  ctx.font = textCss(t);
  ctx.fillStyle = rgbaToCss(t.color);
  ctx.textBaseline = 'top';
  const lh = Math.round(t.size * 1.25);
  t.value.split('\n').forEach((line, i) => ctx.fillText(line, t.x, t.y + i * lh));
  if (!t.antialias) hardenMask(c);
  return c;
}

/** Имя слоя по тексту — первая строка. */
export const textLayerName = (value: string) => value.trim().split('\n')[0].slice(0, 32) || 'Текст';

/** Новый текст в существующем слое (одна запись истории). Имя меняется, если оно было «по тексту». */
export async function updateTextLayer(doc: Doc, layerId: string, text: TextData, label = 'Изменить текст') {
  const l = doc.getLayer(layerId);
  if (!l) return;
  const canvas = await renderTextCanvas(text, doc.width, doc.height);
  const autoName = !l.text || l.name === textLayerName(l.text.value);
  doc.change(label, () => {
    doc.layers = doc.layers.map((x) => (x.id === layerId ? { ...x, canvas, text, name: autoName ? textLayerName(text.value) : x.name } : x));
  });
}

export async function addTextLayer(doc: Doc, text: TextData) {
  const canvas = await renderTextCanvas(text, doc.width, doc.height);
  doc.addLayer({ ...doc.makeLayer(textLayerName(text.value), canvas), text }, 'Текст');
}

/** Верхний видимый текстовый слой под точкой (по пикселям с запасом в несколько px). */
export function textLayerAt(doc: Doc, x: number, y: number): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.visible || !l.text) continue;
    const b = alphaBounds(l.canvas);
    const pad = Math.max(4, l.text.size * 0.2);
    if (b && x >= b.x - pad && y >= b.y - pad && x <= b.x + b.w + pad && y <= b.y + b.h + pad) return l;
  }
  return null;
}

/** Цвет как RGBA из css-hex (для импорта PSD). */
export const rgb = (r: number, g: number, b: number): RGBA => [Math.round(r), Math.round(g), Math.round(b), 255];
