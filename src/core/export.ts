import { zipSync } from 'fflate';
import { alphaBounds, createCanvas, cropCanvas, ctx2d, scaleCanvas } from './canvas';
import { renderLayer } from './composite';
import type { Doc } from './doc';
import { encodeCanvas, fileStem, type ImageFormat } from './io';
import { ensureDir, isTauri, joinPath, pickFolder, saveFileAs, writePath } from './platform';
import type { NineSlice, Rect } from './types';

export type ExportSource = 'layers' | 'slices' | 'merged';
export type ExportOutput = 'folder' | 'zip';

export interface ExportOptions {
  source: ExportSource;
  /** Для source=layers — какие слои; для slices — какие слайсы. */
  ids: string[];
  /** Для slices: резать из сведённого изображения или из активного слоя. */
  sliceFrom: 'merged' | 'layer';
  format: ImageFormat;
  quality: number;
  trim: boolean;
  padding: number;
  scales: number[];
  smoothScale: boolean;
  json: boolean;
  output: ExportOutput;
  prefix: string;
}

export const DEFAULT_EXPORT: ExportOptions = {
  source: 'layers',
  ids: [],
  sliceFrom: 'merged',
  format: 'png',
  quality: 92,
  trim: true,
  padding: 0,
  scales: [1],
  smoothScale: true,
  json: false,
  output: 'folder',
  prefix: '',
};

interface Item {
  name: string;
  canvas: HTMLCanvasElement;
  /** Положение исходной рамки в документе (до обрезки). */
  source: Rect;
  /** Область внутри source, которая попала в файл (после обрезки). */
  trimmed: Rect;
  nine: NineSlice | null;
}

const EXT: Record<ImageFormat, string> = { png: 'png', jpg: 'jpg', webp: 'webp', tiff: 'tif' };

export function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim() || 'image';
}

function uniqueNames(items: Item[]) {
  const used = new Map<string, number>();
  for (const it of items) {
    const base = safeFileName(it.name);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    it.name = n ? `${base}_${n + 1}` : base;
  }
}

function collectItems(doc: Doc, o: ExportOptions): Item[] {
  const full = { x: 0, y: 0, w: doc.width, h: doc.height };
  const raw: { name: string; canvas: HTMLCanvasElement; rect: Rect; nine: NineSlice | null }[] = [];
  if (o.source === 'merged') {
    raw.push({ name: fileStem(doc.name), canvas: doc.composite(), rect: full, nine: null });
  } else if (o.source === 'layers') {
    for (const l of doc.layers) {
      if (!o.ids.includes(l.id)) continue;
      // эффекты, маска и прозрачность запекаются в пиксели; режим наложения в отдельном файле смысла не имеет
      const c = createCanvas(doc.width, doc.height);
      const ctx = ctx2d(c);
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(renderLayer(l, doc.rev), 0, 0);
      raw.push({ name: l.name, canvas: c, rect: full, nine: null });
    }
  } else {
    const src = o.sliceFrom === 'layer' && doc.activeLayer ? doc.activeLayer.canvas : doc.composite();
    for (const s of doc.slices) {
      if (!o.ids.includes(s.id)) continue;
      const rect = { x: s.x, y: s.y, w: s.w, h: s.h };
      raw.push({ name: s.name, canvas: cropCanvas(src, rect), rect, nine: s.nine });
    }
  }
  const items: Item[] = [];
  for (const r of raw) {
    let canvas = r.canvas;
    let trimmed: Rect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    // 9-slice нельзя обрезать: сместятся границы растяжения
    if (o.trim && !r.nine) {
      const b = alphaBounds(canvas);
      if (!b) continue; // полностью пустой элемент не экспортируем
      trimmed = b;
      canvas = cropCanvas(canvas, b);
    }
    if (o.padding > 0) {
      const p = o.padding;
      const padded = createCanvas(canvas.width + p * 2, canvas.height + p * 2);
      ctx2d(padded).drawImage(canvas, p, p);
      canvas = padded;
      trimmed = { x: trimmed.x - p, y: trimmed.y - p, w: trimmed.w + p * 2, h: trimmed.h + p * 2 };
    }
    items.push({ name: o.prefix + r.name, canvas, source: r.rect, trimmed, nine: r.nine });
  }
  uniqueNames(items);
  return items;
}

const scaleSuffix = (s: number) => (s === 1 ? '' : `@${s}x`);

function scaled(c: HTMLCanvasElement, s: number, smooth: boolean) {
  return s === 1 ? c : scaleCanvas(c, Math.max(1, Math.round(c.width * s)), Math.max(1, Math.round(c.height * s)), smooth);
}

export interface ExportResult {
  files: number;
  target: string;
}

export async function runExport(doc: Doc, o: ExportOptions, onProgress?: (done: number, total: number) => void): Promise<ExportResult | null> {
  const items = collectItems(doc, o);
  if (!items.length) throw new Error('Нечего экспортировать: выбранные элементы пусты');
  const files: Record<string, Uint8Array> = {};
  const ext = EXT[o.format];
  const scales = o.scales.length ? o.scales : [1];
  const total = items.length * scales.length;
  let done = 0;
  const tick = async () => {
    onProgress?.(++done, total);
    // отдаём кадр интерфейсу, чтобы прогресс перерисовывался
    await new Promise((r) => setTimeout(r, 0));
  };

  {
    const meta: unknown[] = [];
    for (const it of items) {
      const entry: Record<string, unknown> = {
        name: it.name,
        files: {} as Record<string, string>,
        x: it.source.x + it.trimmed.x,
        y: it.source.y + it.trimmed.y,
        w: it.trimmed.w,
        h: it.trimmed.h,
        source: it.source,
      };
      if (it.nine) entry.nineSlice = it.nine;
      for (const s of scales) {
        const fname = `${it.name}${scaleSuffix(s)}.${ext}`;
        files[fname] = await encodeCanvas(scaled(it.canvas, s, o.smoothScale), o.format, o.quality);
        (entry.files as Record<string, string>)[String(s)] = fname;
        await tick();
      }
      meta.push(entry);
    }
    if (o.json) {
      files[`${safeFileName(o.prefix || fileStem(doc.name))}.json`] = jsonBytes({
        meta: { app: 'PixelYard', document: doc.name, width: doc.width, height: doc.height, scales, format: o.format },
        items: meta,
      });
    }
  }
  return writeOutput(doc, files, o.output === 'zip' || (!isTauri && Object.keys(files).length > 1));
}

async function writeOutput(doc: Doc, files: Record<string, Uint8Array>, asZip: boolean): Promise<ExportResult | null> {
  return writeFiles(files, fileStem(doc.name), asZip);
}

/** Пишет набор файлов в выбранную папку (Tauri) или одним ZIP; в браузере несколько файлов — всегда ZIP. */
export async function writeFiles(files: Record<string, Uint8Array>, zipStem: string, asZip: boolean): Promise<ExportResult | null> {
  const names = Object.keys(files);
  if (asZip || (!isTauri && names.length > 1)) {
    const zip = zipSync(files, { level: 0 }); // PNG/JPG уже сжаты
    const path = await saveFileAs(`${zipStem}.zip`, zip, [{ name: 'ZIP', extensions: ['zip'] }]);
    return path ? { files: names.length, target: path } : null;
  }
  if (!isTauri) {
    // в браузере один файл просто скачиваем
    const n = names[0];
    await saveFileAs(n, files[n], []);
    return { files: 1, target: n };
  }
  const folder = await pickFolder();
  if (!folder) return null;
  await ensureDir(folder);
  for (const n of names) {
    // имена вида «icons/32x32.png» — с подпапками
    const parts = n.split('/');
    if (parts.length > 1) await ensureDir(joinPath(folder, parts.slice(0, -1).join('/')));
    await writePath(joinPath(folder, n), files[n]);
  }
  return { files: names.length, target: folder };
}

const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));
