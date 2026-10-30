import { readPsd, writePsdUint8Array, type Color as PsdColor, type Layer as PsdLayer, type BlendMode as PsdBlend, type LayerEffectsInfo } from 'ag-psd';
import * as UTIF from 'utif2';
import { alphaBounds, canvasToBlob, createCanvas, cropCanvas, ctx2d } from './canvas';
import { Doc } from './doc';
import { decodeProject } from './atlas';
import { newAtlasDoc } from './atlasDoc';
import { largestIconPng } from './icons';
import { isTauri, type FileFilter, type LoadedFile } from './platform';
import { grayToMask, maskToGray } from './composite';
import { DEFAULT_EFFECTS, hasEffects, type BlendMode, type Layer, type LayerEffects, type RGBA } from './types';

export const OPEN_FILTERS: FileFilter[] = [
  {
    name: 'Изображения',
    extensions: ['pyard', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'psd', 'psb', 'tif', 'tiff', 'tga', 'ico', 'icns', 'svg', 'heic', 'avif'],
  },
  { name: 'Проект PixelYard', extensions: ['pyard'] },
  { name: 'Photoshop', extensions: ['psd', 'psb'] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'TIFF', extensions: ['tif', 'tiff'] },
];

export type ImageFormat = 'png' | 'jpg' | 'webp' | 'tiff';

export const FORMAT_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  tiff: 'image/tiff',
};

const ext = (name: string) => name.toLowerCase().split('.').pop() ?? '';
const stem = (name: string) => name.replace(/\.[^.]+$/, '');

// ag-psd использует свои названия режимов наложения
const PSD_TO_BLEND: Partial<Record<PsdBlend, BlendMode>> = {
  normal: 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken',
  lighten: 'lighten', 'color dodge': 'color-dodge', 'color burn': 'color-burn', 'hard light': 'hard-light',
  'soft light': 'soft-light', difference: 'difference', exclusion: 'exclusion', hue: 'hue',
  saturation: 'saturation', color: 'color', luminosity: 'luminosity', 'linear dodge': 'lighter',
};
const BLEND_TO_PSD = Object.fromEntries(Object.entries(PSD_TO_BLEND).map(([k, v]) => [v, k])) as Record<BlendMode, PsdBlend>;

/** Открывает файл как новый документ. */
export async function decodeFile(file: LoadedFile): Promise<Doc> {
  const e = ext(file.name);
  let doc: Doc;
  if (e === 'pyard') {
    const { state } = await decodeProject(file.data);
    doc = newAtlasDoc(file.name, state);
  } else if (e === 'psd' || e === 'psb') doc = decodePsd(file);
  else if (e === 'tif' || e === 'tiff') doc = decodeTiff(file);
  else if (e === 'tga') doc = singleLayerDoc(file.name, decodeTga(file.data));
  else doc = singleLayerDoc(file.name, await decodeBrowserImage(file.data, e));
  doc.path = file.path;
  doc.name = file.name;
  return doc;
}

/** Растр файла без слоёв — для «Поместить» и вставки. */
export async function decodeToCanvas(file: LoadedFile): Promise<HTMLCanvasElement> {
  const e = ext(file.name);
  if (e === 'psd' || e === 'psb' || e === 'tif' || e === 'tiff') return decodeFile(file).then((d) => d.composite());
  if (e === 'tga') return decodeTga(file.data);
  return decodeBrowserImage(file.data, e);
}

function singleLayerDoc(name: string, canvas: HTMLCanvasElement): Doc {
  const doc = new Doc(name, canvas.width, canvas.height);
  const layer = doc.makeLayer(stem(name) || 'Фон', canvas);
  doc.layers = [layer];
  doc.activeLayerId = layer.id;
  return doc;
}

export async function decodeBrowserImage(data: Uint8Array, e: string): Promise<HTMLCanvasElement> {
  // ICO/ICNS: берём самый крупный PNG-кадр
  if (e === 'ico' || e === 'icns') {
    const png = largestIconPng(data, e);
    if (png) return decodeBrowserImage(png, 'png');
    if (e === 'icns') throw new Error('В этом .icns нет PNG-кадров (старый формат) — не поддерживается');
  }
  const mime = e === 'svg' ? 'image/svg+xml' : e === 'jpg' ? 'image/jpeg' : e === 'ico' ? 'image/x-icon' : `image/${e}`;
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    const c = createCanvas(w, h);
    ctx2d(c).drawImage(img, 0, 0, w, h);
    return c;
  } catch {
    throw new Error(`Формат .${e} не поддерживается или файл повреждён`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decodePsd(file: LoadedFile): Doc {
  const psd = readPsd(file.data, { skipThumbnail: true });
  const doc = new Doc(file.name, psd.width, psd.height);
  const layers: Layer[] = [];
  // слои ag-psd идут снизу вверх, как и у нас; группы раскрываем с префиксом имени
  const walk = (list: PsdLayer[], prefix: string, hidden: boolean, opacity: number) => {
    for (const l of list) {
      const name = (prefix ? prefix + ' / ' : '') + (l.name ?? 'Слой');
      const isHidden = hidden || !!l.hidden;
      const op = opacity * (l.opacity ?? 1);
      if (l.children) {
        walk(l.children, name, isHidden, op);
        continue;
      }
      const c = doc.newLayerCanvas();
      if (l.canvas) ctx2d(c).drawImage(l.canvas, l.left ?? 0, l.top ?? 0);
      let mask: HTMLCanvasElement | null = null;
      if (l.mask?.canvas) {
        // маска PSD — серая картинка в своей рамке, вне рамки — defaultColor
        const g = doc.newLayerCanvas();
        const gc = ctx2d(g);
        const dc = l.mask.defaultColor ?? 255;
        gc.fillStyle = `rgb(${dc},${dc},${dc})`;
        gc.fillRect(0, 0, doc.width, doc.height);
        gc.drawImage(l.mask.canvas, l.mask.left ?? 0, l.mask.top ?? 0);
        mask = grayToMask(g);
      }
      layers.push({
        ...doc.makeLayer(name, c),
        visible: !isHidden,
        opacity: op,
        fillOpacity: l.fillOpacity ?? 1,
        clip: !!l.clipping,
        mask,
        maskEnabled: !l.mask?.disabled,
        effects: l.effects ? effectsFromPsd(l.effects) : DEFAULT_EFFECTS,
        blend: (l.blendMode && PSD_TO_BLEND[l.blendMode]) || 'normal',
      });
    }
  };
  walk(psd.children ?? [], '', false, 1);
  if (!layers.length && psd.canvas) {
    const c = doc.newLayerCanvas();
    ctx2d(c).drawImage(psd.canvas, 0, 0);
    layers.push(doc.makeLayer('Фон', c));
  }
  if (!layers.length) layers.push(doc.makeLayer('Фон'));
  doc.layers = layers;
  doc.activeLayerId = layers[layers.length - 1].id;
  return doc;
}

function decodeTiff(file: LoadedFile): Doc {
  const buf = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer;
  const ifds = UTIF.decode(buf);
  const pages: HTMLCanvasElement[] = [];
  for (const ifd of ifds) {
    UTIF.decodeImage(buf, ifd);
    if (!ifd.width || !ifd.height) continue;
    const rgba = UTIF.toRGBA8(ifd);
    const c = createCanvas(ifd.width, ifd.height);
    ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(rgba), ifd.width, ifd.height), 0, 0);
    pages.push(c);
  }
  if (!pages.length) throw new Error('В TIFF нет изображений');
  const w = Math.max(...pages.map((p) => p.width)), h = Math.max(...pages.map((p) => p.height));
  const doc = new Doc(file.name, w, h);
  // многостраничный TIFF → каждая страница отдельным слоем
  doc.layers = pages.map((p, i) => {
    const c = doc.newLayerCanvas();
    ctx2d(c).drawImage(p, 0, 0);
    return { ...doc.makeLayer(pages.length > 1 ? `Страница ${i + 1}` : stem(file.name), c), visible: i === 0 || pages.length === 1 };
  }).reverse();
  doc.activeLayerId = doc.layers[doc.layers.length - 1].id;
  return doc;
}

/** TGA: несжатый и RLE, 8/24/32 бит, любая ориентация. */
function decodeTga(data: Uint8Array): HTMLCanvasElement {
  const idLen = data[0], cmapType = data[1], type = data[2];
  const cmapLen = data[5] | (data[6] << 8), cmapDepth = data[7];
  const w = data[12] | (data[13] << 8), h = data[14] | (data[15] << 8);
  const bpp = data[16], desc = data[17];
  if (cmapType !== 0 || ![2, 3, 10, 11].includes(type)) throw new Error('Этот вариант TGA не поддерживается');
  const bytes = bpp / 8;
  let p = 18 + idLen + cmapLen * Math.ceil(cmapDepth / 8);
  const px = new Uint8ClampedArray(w * h * 4);
  const gray = type === 3 || type === 11;
  const readPixel = (o: number) => {
    if (gray) {
      px[o] = px[o + 1] = px[o + 2] = data[p];
      px[o + 3] = bytes === 2 ? data[p + 1] : 255;
    } else if (bytes === 2) {
      const v = data[p] | (data[p + 1] << 8);
      px[o] = ((v >> 10) & 31) * 255 / 31;
      px[o + 1] = ((v >> 5) & 31) * 255 / 31;
      px[o + 2] = (v & 31) * 255 / 31;
      px[o + 3] = 255;
    } else {
      px[o] = data[p + 2];
      px[o + 1] = data[p + 1];
      px[o + 2] = data[p];
      px[o + 3] = bytes === 4 ? data[p + 3] : 255;
    }
  };
  const total = w * h;
  if (type === 2 || type === 3) {
    for (let i = 0; i < total; i++, p += bytes) readPixel(i * 4);
  } else {
    let i = 0;
    while (i < total) {
      const hdr = data[p++];
      const count = (hdr & 127) + 1;
      if (hdr & 128) {
        readPixel(i * 4);
        p += bytes;
        for (let k = 1; k < count; k++) px.copyWithin((i + k) * 4, i * 4, i * 4 + 4);
        i += count;
      } else {
        for (let k = 0; k < count; k++, i++, p += bytes) readPixel(i * 4);
      }
    }
  }
  const img = new ImageData(px, w, h);
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.putImageData(img, 0, 0);
  const topOrigin = (desc & 0x20) !== 0;
  const rightOrigin = (desc & 0x10) !== 0;
  if (topOrigin && !rightOrigin) return c;
  const out = createCanvas(w, h);
  const octx = ctx2d(out);
  octx.translate(rightOrigin ? w : 0, topOrigin ? 0 : h);
  octx.scale(rightOrigin ? -1 : 1, topOrigin ? 1 : -1);
  octx.drawImage(c, 0, 0);
  return out;
}

// ---------- кодирование ----------

export function encodePsd(doc: Doc): Uint8Array {
  const children: PsdLayer[] = doc.layers.map((l) => {
    const b = alphaBounds(l.canvas);
    const base: PsdLayer = {
      name: l.name,
      hidden: !l.visible,
      opacity: l.opacity,
      fillOpacity: l.fillOpacity,
      clipping: l.clip,
      blendMode: BLEND_TO_PSD[l.blend] ?? 'normal',
    };
    if (hasEffects(l.effects)) base.effects = effectsToPsd(l.effects);
    if (l.mask) base.mask = { left: 0, top: 0, right: doc.width, bottom: doc.height, defaultColor: 0, disabled: !l.maskEnabled, canvas: maskToGray(l.mask) };
    if (!b) return { ...base, left: 0, top: 0, canvas: createCanvas(1, 1) };
    return { ...base, left: b.x, top: b.y, canvas: cropCanvas(l.canvas, b) };
  });
  return writePsdUint8Array({ width: doc.width, height: doc.height, children, canvas: doc.composite() }, { generateThumbnail: true });
}

// ---------- стили слоя ↔ PSD ----------

const px = (value: number) => ({ units: 'Pixels' as const, value });
const toColor = (c: RGBA): PsdColor => ({ r: c[0], g: c[1], b: c[2] });
function fromColor(c: PsdColor | undefined, fallback: RGBA): RGBA {
  if (!c) return fallback;
  if ('r' in c) return [Math.round(c.r), Math.round(c.g), Math.round(c.b), 255];
  if ('fr' in c) return [Math.round(c.fr * 255), Math.round(c.fg * 255), Math.round(c.fb * 255), 255];
  return fallback;
}

function effectsToPsd(e: LayerEffects): LayerEffectsInfo {
  const out: LayerEffectsInfo = {};
  const shadow = (s: LayerEffects['dropShadow'], blend: PsdBlend) => ({
    enabled: s.enabled, present: true, showInDialog: true, color: toColor(s.color), opacity: s.opacity / 100,
    angle: s.angle, distance: px(s.distance), size: px(s.size), blendMode: blend, useGlobalLight: false,
  });
  if (e.dropShadow.enabled) out.dropShadow = [shadow(e.dropShadow, 'multiply')];
  if (e.innerShadow.enabled) out.innerShadow = [shadow(e.innerShadow, 'multiply')];
  if (e.outerGlow.enabled) out.outerGlow = { enabled: true, present: true, showInDialog: true, color: toColor(e.outerGlow.color), opacity: e.outerGlow.opacity / 100, size: px(e.outerGlow.size), blendMode: 'screen' };
  if (e.innerGlow.enabled) out.innerGlow = { enabled: true, present: true, showInDialog: true, color: toColor(e.innerGlow.color), opacity: e.innerGlow.opacity / 100, size: px(e.innerGlow.size), blendMode: 'screen' };
  if (e.colorOverlay.enabled) out.solidFill = [{ enabled: true, present: true, showInDialog: true, color: toColor(e.colorOverlay.color), opacity: e.colorOverlay.opacity / 100, blendMode: BLEND_TO_PSD[e.colorOverlay.blend] ?? 'normal' }];
  if (e.gradientOverlay.enabled) {
    const g = e.gradientOverlay;
    out.gradientOverlay = [{
      enabled: true, present: true, showInDialog: true, opacity: g.opacity / 100, angle: g.angle, type: g.kind, reverse: g.reverse, scale: g.scale / 100, align: true,
      blendMode: BLEND_TO_PSD[g.blend] ?? 'normal',
      gradient: {
        name: 'Custom', type: 'solid', smoothness: 1,
        colorStops: [{ color: toColor(g.from), location: 0, midpoint: 0.5 }, { color: toColor(g.to), location: 1, midpoint: 0.5 }],
        opacityStops: [{ opacity: g.from[3] / 255, location: 0, midpoint: 0.5 }, { opacity: g.to[3] / 255, location: 1, midpoint: 0.5 }],
      },
    }];
  }
  if (e.stroke.enabled) out.stroke = [{ enabled: true, present: true, showInDialog: true, size: px(e.stroke.size), position: e.stroke.position, fillType: 'color', color: toColor(e.stroke.color), opacity: e.stroke.opacity / 100, blendMode: 'normal' }];
  return out;
}

function effectsFromPsd(p: LayerEffectsInfo): LayerEffects {
  const e: LayerEffects = structuredClone(DEFAULT_EFFECTS);
  if (p.disabled) return e;
  const ds = p.dropShadow?.[0];
  if (ds) e.dropShadow = { ...e.dropShadow, enabled: ds.enabled !== false, color: fromColor(ds.color, [0, 0, 0, 255]), opacity: (ds.opacity ?? 0.75) * 100, angle: ds.angle ?? 120, distance: ds.distance?.value ?? 5, size: ds.size?.value ?? 5 };
  const is = p.innerShadow?.[0];
  if (is) e.innerShadow = { ...e.innerShadow, enabled: is.enabled !== false, color: fromColor(is.color, [0, 0, 0, 255]), opacity: (is.opacity ?? 0.75) * 100, angle: is.angle ?? 120, distance: is.distance?.value ?? 5, size: is.size?.value ?? 5 };
  if (p.outerGlow) e.outerGlow = { ...e.outerGlow, enabled: p.outerGlow.enabled !== false, color: fromColor(p.outerGlow.color, e.outerGlow.color), opacity: (p.outerGlow.opacity ?? 0.75) * 100, size: p.outerGlow.size?.value ?? 8 };
  if (p.innerGlow) e.innerGlow = { ...e.innerGlow, enabled: p.innerGlow.enabled !== false, color: fromColor(p.innerGlow.color, e.innerGlow.color), opacity: (p.innerGlow.opacity ?? 0.75) * 100, size: p.innerGlow.size?.value ?? 8 };
  const sf = p.solidFill?.[0];
  if (sf) e.colorOverlay = { ...e.colorOverlay, enabled: sf.enabled !== false, color: fromColor(sf.color, e.colorOverlay.color), opacity: (sf.opacity ?? 1) * 100, blend: (sf.blendMode && PSD_TO_BLEND[sf.blendMode]) || 'normal' };
  const go = p.gradientOverlay?.[0];
  if (go) {
    const stops = go.gradient && go.gradient.type === 'solid' ? go.gradient.colorStops : [];
    e.gradientOverlay = {
      ...e.gradientOverlay,
      enabled: go.enabled !== false,
      opacity: (go.opacity ?? 1) * 100,
      angle: go.angle ?? 90,
      kind: go.type === 'radial' ? 'radial' : 'linear',
      reverse: !!go.reverse,
      scale: (go.scale ?? 1) * 100,
      from: fromColor(stops[0]?.color, e.gradientOverlay.from),
      to: fromColor(stops[stops.length - 1]?.color, e.gradientOverlay.to),
    };
  }
  const st = p.stroke?.[0];
  if (st) e.stroke = { ...e.stroke, enabled: st.enabled !== false, color: fromColor(st.color, [0, 0, 0, 255]), opacity: (st.opacity ?? 1) * 100, size: st.size?.value ?? 3, position: st.position ?? 'outside' };
  return e;
}

let webpNative: boolean | null = null;
function canvasEncodesWebp(): boolean {
  if (webpNative === null) webpNative = createCanvas(1, 1).toDataURL('image/webp').startsWith('data:image/webp');
  return webpNative;
}

/** Кодирует canvas в байты файла. quality: 0..100 (для WebP 100 = без потерь). */
export async function encodeCanvas(c: HTMLCanvasElement, format: ImageFormat, quality = 92): Promise<Uint8Array> {
  if (format === 'tiff') {
    const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
    return new Uint8Array(UTIF.encodeImage(new Uint8Array(d.buffer), c.width, c.height));
  }
  if (format === 'webp' && !canvasEncodesWebp()) {
    if (!isTauri) throw new Error('Этот браузер не умеет кодировать WebP');
    const { invoke } = await import('@tauri-apps/api/core');
    const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
    const res = await invoke<ArrayBuffer>('encode_webp', new Uint8Array(d.buffer), {
      headers: { 'x-width': String(c.width), 'x-height': String(c.height), 'x-quality': String(quality) },
    });
    return new Uint8Array(res);
  }
  let src = c;
  if (format === 'jpg') {
    // JPEG без альфы: подкладываем белый фон, иначе прозрачное станет чёрным
    src = createCanvas(c.width, c.height);
    const ctx = ctx2d(src);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(c, 0, 0);
  }
  const blob = await canvasToBlob(src, FORMAT_MIME[format], format === 'png' ? undefined : quality / 100);
  return new Uint8Array(await blob.arrayBuffer());
}

export function formatFromName(name: string): ImageFormat | 'psd' | null {
  const e = ext(name);
  if (e === 'png') return 'png';
  if (e === 'jpg' || e === 'jpeg') return 'jpg';
  if (e === 'webp') return 'webp';
  if (e === 'tif' || e === 'tiff') return 'tiff';
  if (e === 'psd') return 'psd';
  return null;
}

export { stem as fileStem };
