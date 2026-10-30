import { alphaBounds, createCanvas, cropCanvas, ctx2d, rgbaToCss } from './canvas';
import { renderLayerContent } from './composite';
import { renderTemplate, type FormatDef, type TemplateData } from './atlasFormats';
import { pack, type PackOptions, type PackResult } from './pack';
import { hardenMask } from './selection';
import { DEFAULT_EFFECTS, type GlowFx, type Layer, type LayerEffects, type RGBA, type ShadowFx, type StrokeFx } from './types';

/**
 * Генератор растровых шрифтов: рендер глифов системным или загруженным шрифтом,
 * заливка цветом/градиентом по высоте строки, эффекты из движка стилей слоя,
 * упаковка в атлас и описание в форматах BMFont / JSON / сетка / свой шаблон.
 */

export interface FontSettings {
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
  chars: string;
  letterSpacing: number;
  lineHeight: number; // % от высоты шрифта
  antialias: boolean;
  kerning: boolean;
  padding: number;
  fillMode: 'solid' | 'gradient';
  color: RGBA;
  gradTop: RGBA;
  gradMid: RGBA;
  gradBottom: RGBA;
  gradUseMid: boolean;
  stroke: StrokeFx;
  shadow: ShadowFx;
  glow: GlowFx;
  innerShadow: ShadowFx;
}

export const CHARSETS: { id: string; label: string; chars: string }[] = [
  { id: 'ascii', label: 'ASCII', chars: Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') },
  { id: 'digits', label: 'Цифры и знаки', chars: ' 0123456789+-×x.,:%$€₽/()' },
  {
    id: 'latin-cyr',
    label: 'Латиница + кириллица',
    chars: Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') + 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя№«»—…',
  },
  { id: 'upper', label: 'Заглавные A–Z + цифры', chars: ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.,:-' },
];

export const DEFAULT_FONT: FontSettings = {
  family: 'Arial Black',
  size: 48,
  bold: false,
  italic: false,
  chars: CHARSETS[0].chars,
  letterSpacing: 0,
  lineHeight: 100,
  antialias: true,
  kerning: true,
  padding: 1,
  fillMode: 'gradient',
  color: [255, 255, 255, 255],
  gradTop: [255, 244, 160, 255],
  gradMid: [255, 196, 40, 255],
  gradBottom: [230, 110, 20, 255],
  gradUseMid: true,
  stroke: { ...DEFAULT_EFFECTS.stroke, enabled: true, color: [70, 30, 10, 255], size: 3, position: 'outside' },
  shadow: { ...DEFAULT_EFFECTS.dropShadow, enabled: true, distance: 4, size: 2, opacity: 70, angle: 90 },
  glow: { ...DEFAULT_EFFECTS.outerGlow, enabled: false },
  innerShadow: { ...DEFAULT_EFFECTS.innerShadow, enabled: false, distance: 2, size: 2, opacity: 50 },
};

export interface Glyph {
  char: string;
  id: number;
  canvas: HTMLCanvasElement;
  xoffset: number;
  yoffset: number;
  xadvance: number;
}

export interface RenderedFont {
  face: string;
  size: number;
  lineHeight: number;
  base: number;
  glyphs: Glyph[];
  kernings: { first: number; second: number; amount: number }[];
}

export function fontCss(s: FontSettings) {
  const fam = /[\s,]/.test(s.family) && !s.family.includes(',') ? `"${s.family}"` : s.family;
  return `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${s.size}px ${fam}`;
}

function effectsOf(s: FontSettings): LayerEffects {
  return { ...DEFAULT_EFFECTS, stroke: s.stroke, dropShadow: s.shadow, outerGlow: s.glow, innerShadow: s.innerShadow };
}

/** Сколько места вокруг глифа занимают эффекты. */
function effectsPad(s: FontSettings) {
  let m = 0;
  if (s.stroke.enabled) m = Math.max(m, s.stroke.size + 1);
  if (s.shadow.enabled) m = Math.max(m, s.shadow.distance + s.shadow.size * 2 + 1);
  if (s.glow.enabled) m = Math.max(m, s.glow.size * 2 + 1);
  return Math.ceil(m);
}

/** Уникальные символы набора в порядке появления (по кодовым точкам — эмодзи и суррогаты целиком). */
export function uniqueChars(str: string) {
  return [...new Set(Array.from(str))];
}

export function renderFont(s: FontSettings): RenderedFont {
  const probe = ctx2d(createCanvas(4, 4));
  probe.font = fontCss(s);
  const chars = uniqueChars(s.chars);
  // вертикальные метрики берём у шрифта, а не у конкретных букв — строка должна быть одинаковой
  const mm = probe.measureText('Hgjy');
  const A = mm.fontBoundingBoxAscent || s.size * 0.8;
  const D = mm.fontBoundingBoxDescent || s.size * 0.2;
  const base = Math.round(A);
  const lineHeight = Math.round(((A + D) * s.lineHeight) / 100);
  const fx = effectsOf(s);
  const pad = effectsPad(s) + s.padding;
  const glyphs: Glyph[] = chars.map((ch) => {
    const m = probe.measureText(ch);
    const left = Math.ceil(m.actualBoundingBoxLeft), right = Math.ceil(m.actualBoundingBoxRight);
    const asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
    const xadvance = Math.round(m.width + s.letterSpacing);
    const w = left + right, h = asc + desc;
    const id = ch.codePointAt(0)!;
    if (w <= 0 || h <= 0) return { char: ch, id, canvas: createCanvas(1, 1), xoffset: 0, yoffset: 0, xadvance };
    const c = createCanvas(w + pad * 2 + 2, h + pad * 2 + 2);
    const ctx = ctx2d(c);
    const ox = pad + left + 1, by = pad + asc + 1;
    ctx.font = fontCss(s);
    ctx.textBaseline = 'alphabetic';
    if (s.fillMode === 'gradient') {
      // градиент по всей высоте строки — одинаковый для всех букв
      const g = ctx.createLinearGradient(0, by - A, 0, by + D);
      g.addColorStop(0, rgbaToCss(s.gradTop));
      if (s.gradUseMid) g.addColorStop(0.5, rgbaToCss(s.gradMid));
      g.addColorStop(1, rgbaToCss(s.gradBottom));
      ctx.fillStyle = g;
    } else ctx.fillStyle = rgbaToCss(s.color);
    ctx.fillText(ch, ox, by);
    if (!s.antialias) hardenMask(c);
    const layer: Layer = {
      id: 'glyph', name: ch, canvas: c, visible: true, locked: false, opacity: 1, fillOpacity: 1,
      blend: 'normal', clip: false, mask: null, maskEnabled: false, effects: fx,
    };
    const out = renderLayerContent(layer, c, null);
    const b = alphaBounds(out);
    if (!b) return { char: ch, id, canvas: createCanvas(1, 1), xoffset: 0, yoffset: 0, xadvance };
    return {
      char: ch,
      id,
      canvas: cropCanvas(out, b),
      xoffset: b.x - ox,
      yoffset: b.y - (by - base),
      xadvance,
    };
  });
  const kernings: RenderedFont['kernings'] = [];
  if (s.kerning && chars.length <= 260) {
    const wOf = new Map(chars.map((ch) => [ch, probe.measureText(ch).width]));
    for (const a of chars)
      for (const b of chars) {
        if (a === ' ' || b === ' ') continue;
        const amount = Math.round(probe.measureText(a + b).width - wOf.get(a)! - wOf.get(b)!);
        if (amount !== 0) kernings.push({ first: a.codePointAt(0)!, second: b.codePointAt(0)!, amount });
      }
  }
  return { face: s.family, size: s.size, lineHeight, base, glyphs, kernings };
}

export function isEmptyGlyph(g: Glyph) {
  return g.canvas.width <= 1 && g.canvas.height <= 1 && alphaBounds(g.canvas) === null;
}

// ---------- атлас ----------

export function packFont(f: RenderedFont, o: PackOptions): PackResult {
  return pack(
    f.glyphs.map((g) => {
      const empty = isEmptyGlyph(g);
      return {
        name: g.char,
        canvas: empty ? createCanvas(0, 0) : g.canvas,
        offX: 0, offY: 0,
        srcW: empty ? 0 : g.canvas.width, srcH: empty ? 0 : g.canvas.height,
        extra: { id: g.id, xoffset: g.xoffset, yoffset: g.yoffset, xadvance: g.xadvance },
      };
    }),
    o,
  );
}

/** Моноширинная сетка: у всех ячеек общий размер, базовая линия на одной высоте. */
export function gridFont(f: RenderedFont, columns: number, spacing: number) {
  const vis = f.glyphs.filter((g) => !isEmptyGlyph(g));
  const minX = Math.min(0, ...vis.map((g) => g.xoffset));
  const maxX = Math.max(...f.glyphs.map((g) => g.xadvance), ...vis.map((g) => g.xoffset + g.canvas.width));
  const minY = Math.min(0, ...vis.map((g) => g.yoffset));
  const maxY = Math.max(f.lineHeight, ...vis.map((g) => g.yoffset + g.canvas.height));
  const cw = Math.ceil(maxX - minX), ch = Math.ceil(maxY - minY);
  const cols = Math.max(1, Math.min(columns, f.glyphs.length));
  const rows = Math.ceil(f.glyphs.length / cols);
  const canvas = createCanvas(cols * cw + (cols - 1) * spacing, rows * ch + (rows - 1) * spacing);
  const ctx = ctx2d(canvas);
  f.glyphs.forEach((g, i) => {
    if (isEmptyGlyph(g)) return;
    const col = i % cols, row = Math.floor(i / cols);
    ctx.drawImage(g.canvas, col * (cw + spacing) + g.xoffset - minX, row * (ch + spacing) + g.yoffset - minY);
  });
  return { canvas, cellW: cw, cellH: ch, cols, rows, originX: -minX, baseline: f.base - minY };
}

// ---------- форматы описания ----------

export function fontTemplateData(f: RenderedFont, p: PackResult, image: string, s: FontSettings): TemplateData {
  const xmlEsc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return {
    face: f.face,
    size: f.size,
    bold: s.bold ? 1 : 0,
    italic: s.italic ? 1 : 0,
    lineHeight: f.lineHeight,
    base: f.base,
    image,
    width: p.width,
    height: p.height,
    count: p.frames.length,
    chars: p.frames.map((fr) => ({
      id: fr.extra!.id as number,
      char: fr.name,
      charXml: xmlEsc(fr.name),
      charJson: JSON.stringify(fr.name),
      x: fr.x, y: fr.y, w: fr.w, h: fr.h,
      xoffset: fr.extra!.xoffset as number,
      yoffset: fr.extra!.yoffset as number,
      xadvance: fr.extra!.xadvance as number,
    })),
    kernings: f.kernings.map((k) => ({ ...k })),
    kerningsCount: f.kernings.length,
  };
}

const FNT_TEXT = `info face="{{face}}" size={{size}} bold={{bold}} italic={{italic}} charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=0,0 outline=0
common lineHeight={{lineHeight}} base={{base}} scaleW={{width}} scaleH={{height}} pages=1 packed=0 alphaChnl=0 redChnl=0 greenChnl=0 blueChnl=0
page id=0 file="{{image}}"
chars count={{count}}
{{#chars}}char id={{id}} x={{x}} y={{y}} width={{w}} height={{h}} xoffset={{xoffset}} yoffset={{yoffset}} xadvance={{xadvance}} page=0 chnl=15
{{/chars}}kernings count={{kerningsCount}}
{{#kernings}}kerning first={{first}} second={{second}} amount={{amount}}
{{/kernings}}`;

const FNT_XML = `<?xml version="1.0"?>
<font>
  <info face="{{face}}" size="{{size}}" bold="{{bold}}" italic="{{italic}}" charset="" unicode="1" stretchH="100" smooth="1" aa="1" padding="0,0,0,0" spacing="0,0" outline="0"/>
  <common lineHeight="{{lineHeight}}" base="{{base}}" scaleW="{{width}}" scaleH="{{height}}" pages="1" packed="0" alphaChnl="0" redChnl="0" greenChnl="0" blueChnl="0"/>
  <pages>
    <page id="0" file="{{image}}"/>
  </pages>
  <chars count="{{count}}">
{{#chars}}    <char id="{{id}}" x="{{x}}" y="{{y}}" width="{{w}}" height="{{h}}" xoffset="{{xoffset}}" yoffset="{{yoffset}}" xadvance="{{xadvance}}" page="0" chnl="15"/>
{{/chars}}  </chars>
  <kernings count="{{kerningsCount}}">
{{#kernings}}    <kerning first="{{first}}" second="{{second}}" amount="{{amount}}"/>
{{/kernings}}  </kernings>
</font>
`;

export const FONT_FORMATS: FormatDef[] = [
  { id: 'fnt', label: 'BMFont текстовый (.fnt)', ext: 'fnt', kind: 'font', template: FNT_TEXT, render: (d) => renderTemplate(FNT_TEXT, d) },
  { id: 'fnt-xml', label: 'BMFont XML (.fnt)', ext: 'fnt', kind: 'font', template: FNT_XML, render: (d) => renderTemplate(FNT_XML, d) },
  {
    id: 'json',
    label: 'JSON',
    ext: 'json',
    kind: 'font',
    render: (d) =>
      JSON.stringify(
        {
          face: d.face,
          size: d.size,
          lineHeight: d.lineHeight,
          base: d.base,
          image: d.image,
          scaleW: d.width,
          scaleH: d.height,
          chars: (d.chars as TemplateData[]).map((c) => ({ id: c.id, char: c.char, x: c.x, y: c.y, width: c.w, height: c.h, xoffset: c.xoffset, yoffset: c.yoffset, xadvance: c.xadvance })),
          kernings: d.kernings,
        },
        null,
        2,
      ),
  },
];

export const FONT_VARS: [string, string][] = [
  ['{{face}} {{size}}', 'гарнитура и кегль'],
  ['{{lineHeight}} {{base}}', 'высота строки и базовая линия'],
  ['{{image}} {{width}} {{height}}', 'атлас и его размер'],
  ['{{count}}', 'число символов'],
  ['{{#chars}}…{{/chars}}', 'повтор для каждого символа'],
  ['{{id}} {{char}}', 'код Unicode и сам символ ({{charJson}}, {{charXml}})'],
  ['{{x}} {{y}} {{w}} {{h}}', 'положение в атласе'],
  ['{{xoffset}} {{yoffset}} {{xadvance}}', 'смещения и шаг'],
  ['{{#kernings}}{{first}} {{second}} {{amount}}{{/kernings}}', 'кернинг (коды символов)'],
  ['{{^last}},{{/last}}', 'разделитель между элементами'],
];
