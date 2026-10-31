import { alphaBounds, createCanvas, ctx2d, rgbaToCss } from './canvas';
import type { Doc } from './doc';
import { bitmapTextWidth, drawBitmapText, fontGlyphs } from './fontLibrary';
import type { RenderedFont } from './bmfont';
import { hardenMask } from './selection';
import type { Layer, Rect, RGBA, TextData } from './types';

/**
 * Текстовые слои: в слое хранится TextData, пиксели строятся из неё заново при каждой правке.
 * Растрирование убирает TextData — дальше слой обычный.
 */

export const isTextLayer = (l: Layer | null | undefined): l is Layer & { text: TextData } => !!l?.text;

const bitmapId = (font: string) => (font.startsWith('bmfont:') ? font.slice(7) : null);

export function textCss(t: TextData) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.size}px ${t.font}`;
}

/** Межстрочный интервал векторного текста. */
export const LINE_HEIGHT = 1.25;

export interface TextLine {
  text: string;
  /** Левый край строки и её верх, в координатах документа. */
  x: number;
  y: number;
  w: number;
  /** По ширине: слова строки со своими позициями x (пробелы растянуты). */
  words?: { text: string; x: number }[];
}

export interface TextLayout {
  lines: TextLine[];
  lineHeight: number;
  /** Рамка текста: у текста в рамке — сама рамка, у точечного — описанный прямоугольник строк. */
  bounds: Rect;
}

/** Перенос по словам под ширину (длинное слово режется по буквам). Пробелы в конце строки сохраняются. */
function wrapLine(line: string, maxW: number, measure: (s: string) => number): string[] {
  if (measure(line) <= maxW) return [line];
  const out: string[] = [];
  let cur = '';
  for (const word of line.match(/\S+\s*|\s+/g) ?? ['']) {
    if (measure(cur + word.trimEnd()) <= maxW || !cur) {
      if (!cur && measure(word.trimEnd()) > maxW) {
        // слово само шире рамки — по буквам
        for (const ch of word) {
          if (cur && measure(cur + ch) > maxW && ch.trim()) {
            out.push(cur);
            cur = '';
          }
          cur += ch;
        }
      } else cur += word;
    } else {
      out.push(cur);
      cur = word;
    }
  }
  out.push(cur);
  return out;
}

/** Раскладка строк: перенос в рамке, выравнивание по ширине и высоте. measure — ширина строки в px документа. */
export function layoutText(t: TextData, measure: (s: string) => number, lineHeight: number): TextLayout {
  const align = t.align ?? 'left';
  const raw = t.value.split('\n');
  // для «по ширине» нужно знать, какая строка последняя в абзаце — её не растягиваем
  const lastOfPara: boolean[] = [];
  const texts = t.box
    ? raw.flatMap((l) => {
        const parts = wrapLine(l, Math.max(1, t.box!.w), measure);
        parts.forEach((_, i) => lastOfPara.push(i === parts.length - 1));
        return parts;
      })
    : raw;
  const widths = texts.map((l) => measure(t.box ? l.trimEnd() : l));
  const contentH = texts.length * lineHeight;
  const maxW = Math.max(0, ...widths);
  let left: number, top: number, boxW: number, boxH: number;
  if (t.box) {
    [left, top, boxW, boxH] = [t.x, t.y, t.box.w, t.box.h];
    const v = t.valign ?? 'top';
    top += v === 'middle' ? (boxH - contentH) / 2 : v === 'bottom' ? boxH - contentH : 0;
  } else {
    // точечный текст: x — левый край, центр или правый край
    left = align === 'center' ? t.x - maxW / 2 : align === 'right' ? t.x - maxW : t.x; // justify без рамки — как влево
    top = t.y;
    boxW = maxW;
    boxH = contentH;
  }
  const lines = texts.map((text, i) => {
    const w = widths[i];
    const x = align === 'center' ? left + (boxW - w) / 2 : align === 'right' ? left + boxW - w : left;
    const line: TextLine = { text, x, y: top + i * lineHeight, w };
    if (align === 'justify' && t.box && !lastOfPara[i]) {
      const lead = text.match(/^\s*/)![0];
      const words = text.trim().split(/\s+/);
      if (words.length > 1) {
        const ww = words.map(measure);
        const gap = (boxW - measure(lead) - ww.reduce((a, b) => a + b, 0)) / (words.length - 1);
        let cx = left + measure(lead);
        line.words = words.map((wd, k) => {
          const pos = { text: wd, x: cx };
          cx += ww[k] + gap;
          return pos;
        });
        line.w = boxW;
      }
    }
    return line;
  });
  const bounds = t.box ? { x: t.x, y: t.y, w: t.box.w, h: t.box.h } : { x: left, y: top, w: maxW, h: contentH };
  return { lines, lineHeight, bounds };
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Раскладка векторного текста (шрифт CSS). */
export function layoutVector(t: TextData): TextLayout {
  measureCtx ??= ctx2d(createCanvas(1, 1));
  measureCtx.font = textCss(t);
  return layoutText(t, (s) => measureCtx!.measureText(s).width, Math.round(t.size * LINE_HEIGHT));
}

/** Раскладка текста растровым шрифтом. */
export function layoutBitmap(t: TextData, f: RenderedFont): TextLayout {
  const o = { scale: t.size / Math.max(1, f.size), letterSpacing: 0 };
  return layoutText(t, (s) => bitmapTextWidth(f, s, o), f.lineHeight * o.scale);
}

/** Раскладка любого текста (растровый шрифт — если уже загружен). */
export async function layoutAny(t: TextData): Promise<TextLayout> {
  const bm = bitmapId(t.font);
  const f = bm ? await fontGlyphs(bm) : null;
  return f ? layoutBitmap(t, f) : layoutVector(t);
}

/** Рисует строки раскладки на ctx (координаты документа). */
export function drawTextLayout(ctx: CanvasRenderingContext2D, t: TextData, L: TextLayout, f: RenderedFont | null) {
  if (f) {
    const o = { scale: t.size / Math.max(1, f.size), letterSpacing: 0, tint: t.bmTint ? t.color : null, smooth: t.antialias };
    for (const l of L.lines) {
      if (l.words) for (const w of l.words) drawBitmapText(ctx, f, w.text, Math.round(w.x), Math.round(l.y), o);
      else if (l.text) drawBitmapText(ctx, f, l.text, Math.round(l.x), Math.round(l.y), o);
    }
    return;
  }
  ctx.font = textCss(t);
  ctx.fillStyle = rgbaToCss(t.color);
  // базовая линия — как в CSS (поле ввода): высота шрифта по центру строки, отсюда отступ сверху
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent ?? t.size * 0.8, desc = m.fontBoundingBoxDescent ?? t.size * 0.2;
  const base = (L.lineHeight - (asc + desc)) / 2 + asc;
  for (const l of L.lines) {
    if (l.words) for (const w of l.words) ctx.fillText(w.text, w.x, l.y + base);
    else ctx.fillText(l.text, l.x, l.y + base);
  }
}

/** Пиксели текста на холсте размером с документ. */
export async function renderTextCanvas(t: TextData, w: number, h: number): Promise<HTMLCanvasElement> {
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  const bm = bitmapId(t.font);
  if (bm) {
    const f = await fontGlyphs(bm);
    if (!f) throw new Error('Растровый шрифт этого слоя не найден в библиотеке (меню «Шрифт»)');
    drawTextLayout(ctx, t, layoutBitmap(t, f), f);
    return c;
  }
  drawTextLayout(ctx, t, layoutVector(t), null);
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
    const b = l.text.box ? { x: l.text.x, y: l.text.y, w: l.text.box.w, h: l.text.box.h } : alphaBounds(l.canvas);
    const pad = Math.max(4, l.text.size * 0.2);
    if (b && x >= b.x - pad && y >= b.y - pad && x <= b.x + b.w + pad && y <= b.y + b.h + pad) return l;
  }
  return null;
}

/** Цвет как RGBA из css-hex (для импорта PSD). */
export const rgb = (r: number, g: number, b: number): RGBA => [Math.round(r), Math.round(g), Math.round(b), 255];
