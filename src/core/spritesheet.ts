import { createCanvas, ctx2d, scaleCanvas } from './canvas';
import { spriteTemplateData, type FormatDef } from './atlasFormats';
import { encodeCanvas, type ImageFormat } from './io';
import { pack, trimSprite, type PackOptions, type PackResult } from './pack';

/** Спрайт для упаковки: имя и полное изображение кадра (до обрезки). */
export interface SpriteSource {
  name: string;
  canvas: HTMLCanvasElement;
}

export interface SheetOptions extends PackOptions {
  trim: boolean;
  scales: number[];
  smoothScale: boolean;
  imageFormat: ImageFormat;
  quality: number;
  /** Имя файлов без расширения. */
  name: string;
}

export const DEFAULT_SHEET: Omit<SheetOptions, 'name'> = {
  maxSize: 2048,
  spacing: 2,
  border: 0,
  extrude: 0,
  pot: true,
  square: false,
  trim: true,
  scales: [1],
  smoothScale: true,
  imageFormat: 'png',
  quality: 92,
};

/** Уникальные имена кадров: одинаковые получают суффикс _2, _3… */
export function uniqueSpriteNames(list: SpriteSource[]): SpriteSource[] {
  const used = new Map<string, number>();
  return list.map((s) => {
    const n = used.get(s.name) ?? 0;
    used.set(s.name, n + 1);
    return n ? { ...s, name: `${s.name}_${n + 1}` } : s;
  });
}

export function packSprites(list: SpriteSource[], o: SheetOptions, scale = 1): PackResult {
  const items = uniqueSpriteNames(list)
    .map((s) => {
      const c = scale === 1 ? s.canvas : scaleCanvas(s.canvas, Math.max(1, Math.round(s.canvas.width * scale)), Math.max(1, Math.round(s.canvas.height * scale)), o.smoothScale);
      return trimSprite(s.name, c, o.trim);
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!items.length) throw new Error('Все выбранные спрайты пустые');
  return pack(items, o);
}

const EXT: Record<ImageFormat, string> = { png: 'png', jpg: 'jpg', webp: 'webp', tiff: 'tif' };
const suffix = (s: number) => (s === 1 ? '' : `@${s}x`);

/** Готовые файлы спрайтшита для всех масштабов: картинка + описание. */
export async function buildSheetFiles(list: SpriteSource[], o: SheetOptions, format: FormatDef): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const s of o.scales.length ? o.scales : [1]) {
    const p = packSprites(list, o, s);
    const image = `${o.name}${suffix(s)}.${EXT[o.imageFormat]}`;
    files[image] = await encodeCanvas(p.canvas, o.imageFormat, o.quality);
    const text = format.render(spriteTemplateData(p.frames, { image, width: p.width, height: p.height, scale: s, app: 'PixelYard' }));
    files[`${o.name}${suffix(s)}.${format.ext}`] = new TextEncoder().encode(text);
  }
  return files;
}

/** Доля полезной площади атласа — для подсказки в интерфейсе. */
export function efficiency(p: PackResult) {
  const used = p.frames.reduce((s, f) => s + f.w * f.h, 0);
  return used / Math.max(1, p.width * p.height);
}

/** Пустой холст-заглушка, когда упаковать нечего. */
export function emptySheet() {
  const c = createCanvas(64, 64);
  ctx2d(c);
  return c;
}
