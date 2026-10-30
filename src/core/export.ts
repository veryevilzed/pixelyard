import { zipSync } from 'fflate';
import { alphaBounds, createCanvas, cropCanvas, ctx2d, scaleCanvas } from './canvas';
import { renderLayer } from './composite';
import type { Doc } from './doc';
import { encodeCanvas, fileStem, type ImageFormat } from './io';
import { ensureDir, isTauri, joinPath, pickFolder, saveFileAs, writePath } from './platform';
import type { NineSlice, Rect } from './types';

export type ExportSource = 'layers' | 'slices' | 'merged';
export type ExportOutput = 'folder' | 'zip' | 'atlas';

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
  atlasMaxSize: number;
  atlasSpacing: number;
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
  atlasMaxSize: 4096,
  atlasSpacing: 2,
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

  if (o.output === 'atlas') {
    for (const s of scales) {
      const packed = packAtlas(items.map((it) => scaled(it.canvas, s, o.smoothScale)), o.atlasMaxSize, o.atlasSpacing);
      const base = `${safeFileName(o.prefix || fileStem(doc.name))}${scaleSuffix(s)}`;
      files[`${base}.${ext}`] = await encodeCanvas(packed.canvas, o.format, o.quality);
      files[`${base}.json`] = jsonBytes(atlasJson(doc, items, packed.rects, `${base}.${ext}`, packed.canvas, s));
      done += items.length;
      onProgress?.(done, total);
    }
  } else {
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
        meta: { app: 'PhotoEdit', document: doc.name, width: doc.width, height: doc.height, scales, format: o.format },
        items: meta,
      });
    }
  }
  return writeOutput(doc, files, o.output === 'zip' || (!isTauri && Object.keys(files).length > 1));
}

async function writeOutput(doc: Doc, files: Record<string, Uint8Array>, asZip: boolean): Promise<ExportResult | null> {
  const names = Object.keys(files);
  if (asZip) {
    const zip = zipSync(files, { level: 0 }); // PNG/JPG уже сжаты
    const path = await saveFileAs(`${fileStem(doc.name)}.zip`, zip, [{ name: 'ZIP', extensions: ['zip'] }]);
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
  for (const n of names) await writePath(joinPath(folder, n), files[n]);
  return { files: names.length, target: folder };
}

const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));

// ---------- упаковка атласа ----------

interface Packed {
  canvas: HTMLCanvasElement;
  rects: Rect[];
}

/**
 * Полочная упаковка (shelf) по убыванию высоты: просто и предсказуемо,
 * для спрайтов похожих размеров плотность близка к MaxRects.
 */
export function packAtlas(canvases: HTMLCanvasElement[], maxSize: number, spacing: number): Packed {
  const order = canvases.map((_c, i) => i).sort((a, b) => canvases[b].height - canvases[a].height || canvases[b].width - canvases[a].width);
  const area = canvases.reduce((s, c) => s + (c.width + spacing) * (c.height + spacing), 0);
  const widest = Math.max(...canvases.map((c) => c.width));
  // ширина — степень двойки, начиная с ~sqrt(площади)
  let width = 1;
  while (width < Math.max(widest, Math.sqrt(area))) width *= 2;
  width = Math.min(width, maxSize);
  const rects: Rect[] = new Array(canvases.length);
  let x = 0, y = 0, shelf = 0;
  for (const i of order) {
    const c = canvases[i];
    if (x + c.width > width) {
      x = 0;
      y += shelf + spacing;
      shelf = 0;
    }
    rects[i] = { x, y, w: c.width, h: c.height };
    x += c.width + spacing;
    shelf = Math.max(shelf, c.height);
  }
  const usedH = y + shelf;
  let height = 1;
  while (height < usedH) height *= 2;
  if (width > maxSize || height > maxSize) throw new Error(`Спрайты не помещаются в атлас ${maxSize}×${maxSize}`);
  const out = createCanvas(width, height);
  const ctx = ctx2d(out);
  canvases.forEach((c, i) => ctx.drawImage(c, rects[i].x, rects[i].y));
  return { canvas: out, rects };
}

/** JSON в формате TexturePacker «JSON (Hash)» — понимают Phaser, Pixi, Cocos и др. */
function atlasJson(doc: Doc, items: Item[], rects: Rect[], image: string, atlas: HTMLCanvasElement, scale: number) {
  const frames: Record<string, unknown> = {};
  items.forEach((it, i) => {
    const r = rects[i];
    const srcW = Math.round(it.source.w * scale), srcH = Math.round(it.source.h * scale);
    frames[it.name] = {
      frame: r,
      rotated: false,
      trimmed: r.w !== srcW || r.h !== srcH,
      spriteSourceSize: { x: Math.round(it.trimmed.x * scale), y: Math.round(it.trimmed.y * scale), w: r.w, h: r.h },
      sourceSize: { w: srcW, h: srcH },
      ...(it.nine ? { nineSlice: it.nine } : {}),
    };
  });
  return {
    frames,
    meta: { app: 'PhotoEdit', version: '1.0', image, format: 'RGBA8888', size: { w: atlas.width, h: atlas.height }, scale: String(scale), source: doc.name },
  };
}
