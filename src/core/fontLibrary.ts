import { create } from 'zustand';
import { createCanvas, cropCanvas, ctx2d, rgbaToCss, uid } from './canvas';
import { renderFont, type FontSettings, type Glyph, type RenderedFont } from './bmfont';
import type { RGBA } from './types';

/**
 * Библиотека растровых шрифтов: созданные в генераторе BMFont (хранятся настройки, глифы
 * перерисовываются) и открытые из файлов .fnt + PNG. Ими можно писать инструментом «Текст».
 */

export interface BitmapFont {
  id: string;
  name: string;
  source: 'generated' | 'file';
  /** Для созданных — настройки генератора (шрифт можно отредактировать). */
  settings?: FontSettings;
  /** Для открытых из файла — исходники, чтобы восстановить после перезапуска. */
  files?: { fnt: string; pages: { name: string; dataUrl: string }[] };
  font: RenderedFont | null;
}

const KEY = 'pixelyard.bmfonts';

interface Stored {
  id: string;
  name: string;
  source: BitmapFont['source'];
  settings?: FontSettings;
  files?: BitmapFont['files'];
}

export const useFonts = create<{ fonts: BitmapFont[] }>(() => ({
  fonts: (() => {
    try {
      return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Stored[]).map((s) => ({ ...s, font: null }));
    } catch {
      return [];
    }
  })(),
}));

function persist(fonts: BitmapFont[]) {
  const data: Stored[] = fonts.map(({ id, name, source, settings, files }) => ({ id, name, source, settings, files }));
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // большие PNG не влезают в localStorage — сохраняем без них (шрифт останется до перезапуска)
    localStorage.setItem(KEY, JSON.stringify(data.map((d) => (d.source === 'file' ? { ...d, files: undefined } : d)).filter((d) => d.source !== 'file' || d.files)));
  }
}

export function saveFont(f: BitmapFont) {
  const list = useFonts.getState().fonts;
  const fonts = list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f];
  useFonts.setState({ fonts });
  persist(fonts);
}

export function removeFont(id: string) {
  const fonts = useFonts.getState().fonts.filter((f) => f.id !== id);
  useFonts.setState({ fonts });
  persist(fonts);
}

/** Глифы шрифта (созданные перерисовываются при первом обращении). */
export async function fontGlyphs(id: string): Promise<RenderedFont | null> {
  const f = useFonts.getState().fonts.find((x) => x.id === id);
  if (!f) return null;
  if (f.font) return f.font;
  let font: RenderedFont | null = null;
  if (f.source === 'generated' && f.settings) font = renderFont(f.settings);
  if (f.source === 'file' && f.files) {
    const pages = await Promise.all(f.files.pages.map((p) => imageFromUrl(p.dataUrl)));
    font = fontFromFnt(parseFnt(f.files.fnt), pages);
  }
  if (font) useFonts.setState((s) => ({ fonts: s.fonts.map((x) => (x.id === id ? { ...x, font } : x)) }));
  return font;
}

async function imageFromUrl(url: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = createCanvas(img.naturalWidth, img.naturalHeight);
  ctx2d(c).drawImage(img, 0, 0);
  return c;
}

// ---------- чтение .fnt ----------

export interface ParsedFnt {
  face: string;
  size: number;
  lineHeight: number;
  base: number;
  pages: string[];
  chars: { id: number; x: number; y: number; width: number; height: number; xoffset: number; yoffset: number; xadvance: number; page: number }[];
  kernings: { first: number; second: number; amount: number }[];
}

/** BMFont: текстовый формат или XML. */
export function parseFnt(text: string): ParsedFnt {
  const out: ParsedFnt = { face: '', size: 0, lineHeight: 0, base: 0, pages: [], chars: [], kernings: [] };
  const attrs = (s: string) => {
    const m: Record<string, string> = {};
    for (const a of s.matchAll(/(\w+)=("([^"]*)"|\S+)/g)) m[a[1]] = a[3] ?? a[2];
    return m;
  };
  const num = (v: string | undefined) => Number(v ?? 0) || 0;
  const xml = text.trimStart().startsWith('<');
  const entries = xml ? [...text.matchAll(/<(info|common|page|char|kerning)\s([^>]*?)\/?>/g)].map((m) => [m[1], m[2]] as const) : text.split(/\r?\n/).map((l) => [l.split(/\s/)[0], l.slice(l.indexOf(' ') + 1)] as const);
  for (const [tag, rest] of entries) {
    const a = attrs(rest);
    if (tag === 'info') {
      out.face = a.face ?? '';
      out.size = Math.abs(num(a.size));
    } else if (tag === 'common') {
      out.lineHeight = num(a.lineHeight);
      out.base = num(a.base);
    } else if (tag === 'page') out.pages[num(a.id)] = a.file ?? '';
    else if (tag === 'char') out.chars.push({ id: num(a.id), x: num(a.x), y: num(a.y), width: num(a.width), height: num(a.height), xoffset: num(a.xoffset), yoffset: num(a.yoffset), xadvance: num(a.xadvance), page: num(a.page) });
    else if (tag === 'kerning') out.kernings.push({ first: num(a.first), second: num(a.second), amount: num(a.amount) });
  }
  if (!out.chars.length) throw new Error('В файле нет символов — это не BMFont .fnt');
  if (!out.size) out.size = out.lineHeight;
  return out;
}

export function fontFromFnt(p: ParsedFnt, pages: HTMLCanvasElement[]): RenderedFont {
  const glyphs: Glyph[] = p.chars.map((c) => ({
    char: String.fromCodePoint(c.id),
    id: c.id,
    canvas: c.width > 0 && c.height > 0 && pages[c.page] ? cropCanvas(pages[c.page], { x: c.x, y: c.y, w: c.width, h: c.height }) : createCanvas(1, 1),
    xoffset: c.xoffset,
    yoffset: c.yoffset,
    xadvance: c.xadvance,
  }));
  return { face: p.face, size: p.size, lineHeight: p.lineHeight, base: p.base, glyphs, kernings: p.kernings };
}

/** Открытие .fnt: страницы ищутся среди выбранных файлов по имени. */
export async function importFnt(fnt: { name: string; text: string }, images: { name: string; data: Uint8Array }[]): Promise<BitmapFont> {
  const parsed = parseFnt(fnt.text);
  const base = (n: string) => n.split(/[\\/]/).pop()!.toLowerCase();
  const pages: { name: string; dataUrl: string }[] = [];
  for (const file of parsed.pages) {
    const img = images.find((i) => base(i.name) === base(file));
    if (!img) throw new Error(`Не найдена страница шрифта «${file}» — выберите её вместе с .fnt`);
    const ext = file.toLowerCase().endsWith('.webp') ? 'webp' : file.toLowerCase().match(/\.jpe?g$/) ? 'jpeg' : 'png';
    pages.push({ name: file, dataUrl: await toDataUrl(img.data, `image/${ext}`) });
  }
  const files = { fnt: fnt.text, pages };
  const canvases = await Promise.all(pages.map((p) => imageFromUrl(p.dataUrl)));
  return { id: uid('fn'), name: parsed.face || fnt.name.replace(/\.\w+$/, ''), source: 'file', files, font: fontFromFnt(parsed, canvases) };
}

function toDataUrl(data: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([data as BlobPart], { type: mime }));
  });
}

// ---------- текст растровым шрифтом ----------

export interface BitmapTextOptions {
  /** Множитель размера (кегль / размер шрифта). */
  scale: number;
  letterSpacing: number;
  /** Перекрасить глифы в цвет (для белых шрифтов), null — как есть. */
  tint: RGBA | null;
  smooth: boolean;
}

/** Ширина строки в пикселях шрифта (без масштаба). */
function lineWidth(f: RenderedFont, line: string, kern: Map<string, number>, spacing: number) {
  const map = new Map(f.glyphs.map((g) => [g.id, g]));
  let x = 0, prev = 0;
  for (const ch of line) {
    const id = ch.codePointAt(0)!;
    x += (kern.get(`${prev}:${id}`) ?? 0) + (map.get(id)?.xadvance ?? f.size / 2) + spacing;
    prev = id;
  }
  return x;
}

/** Рисует текст глифами шрифта; возвращает размер нарисованного. */
export function drawBitmapText(ctx: CanvasRenderingContext2D, f: RenderedFont, text: string, x: number, y: number, o: BitmapTextOptions) {
  const map = new Map(f.glyphs.map((g) => [g.id, g]));
  const kern = new Map(f.kernings.map((k) => [`${k.first}:${k.second}`, k.amount]));
  const lines = text.split('\n');
  const W = Math.ceil(Math.max(...lines.map((l) => lineWidth(f, l, kern, o.letterSpacing))) * o.scale) + 4;
  const H = Math.ceil(lines.length * f.lineHeight * o.scale) + 4;
  // рисуем в отдельный холст — так перекраска не задевает то, что уже есть на ctx
  const buf = createCanvas(Math.max(1, W), Math.max(1, H));
  const b = ctx2d(buf);
  b.imageSmoothingEnabled = o.smooth;
  lines.forEach((line, li) => {
    let cx = 0, prev = 0;
    for (const ch of line) {
      const id = ch.codePointAt(0)!;
      const g = map.get(id);
      cx += kern.get(`${prev}:${id}`) ?? 0;
      if (g && g.canvas.width > 1) b.drawImage(g.canvas, (cx + g.xoffset) * o.scale, (li * f.lineHeight + g.yoffset) * o.scale, g.canvas.width * o.scale, g.canvas.height * o.scale);
      cx += (g?.xadvance ?? f.size / 2) + o.letterSpacing;
      prev = id;
    }
  });
  if (o.tint) {
    b.globalCompositeOperation = 'source-in';
    b.fillStyle = rgbaToCss(o.tint);
    b.fillRect(0, 0, W, H);
  }
  ctx.drawImage(buf, x, y);
  return { w: W, h: H };
}
