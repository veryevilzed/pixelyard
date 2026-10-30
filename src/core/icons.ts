import { createCanvas, ctx2d, scaleCanvas } from './canvas';
import { encodeCanvas } from './io';

/**
 * Иконки приложения: ICO (Windows, favicon), ICNS (macOS) и наборы PNG под платформы.
 * Внутри ICO и ICNS — PNG (поддерживается с Windows Vista и macOS 10.7).
 */

export interface IconStyle {
  /** Поля вокруг картинки, доля стороны (0..0.3). */
  padding: number;
  /** Скругление углов, доля стороны (0..0.5; 0.5 — круг). */
  radius: number;
  /** Подложка; null — прозрачная. */
  background: string | null;
  smooth: boolean;
}

/** Квадратная иконка size×size: картинка вписывается с полями, подложкой и скруглением. */
export function renderIcon(src: HTMLCanvasElement, size: number, st: IconStyle): HTMLCanvasElement {
  const out = createCanvas(size, size);
  const ctx = ctx2d(out);
  const r = st.radius * size;
  if (r > 0) {
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, Math.min(r, size / 2));
    ctx.clip();
  }
  if (st.background) {
    ctx.fillStyle = st.background;
    ctx.fillRect(0, 0, size, size);
  }
  const inner = size * (1 - st.padding * 2);
  const k = Math.min(inner / src.width, inner / src.height);
  const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
  const img = scaleCanvas(src, w, h, st.smooth);
  ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2));
  return out;
}

/** ICO из PNG-кадров (размер 256 записывается как 0). */
export function encodeIco(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const head = 6 + images.length * 16;
  const total = head + images.reduce((s, i) => s + i.png.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true); // тип: иконка
  v.setUint16(4, images.length, true);
  let off = head;
  images.forEach((im, i) => {
    const e = 6 + i * 16;
    out[e] = im.size >= 256 ? 0 : im.size;
    out[e + 1] = im.size >= 256 ? 0 : im.size;
    v.setUint16(e + 4, 1, true); // плоскости
    v.setUint16(e + 6, 32, true); // бит на пиксель
    v.setUint32(e + 8, im.png.length, true);
    v.setUint32(e + 12, off, true);
    out.set(im.png, off);
    off += im.png.length;
  });
  return out;
}

/** Типы ICNS: пиксельный размер → коды (обычный и @2x меньшего размера). */
const ICNS_TYPES: [string, number][] = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];
export const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];

export function encodeIcns(pngBySize: Map<number, Uint8Array>): Uint8Array {
  const entries = ICNS_TYPES.filter(([, s]) => pngBySize.has(s)).map(([type, s]) => ({ type, png: pngBySize.get(s)! }));
  const total = 8 + entries.reduce((s, e) => s + 8 + e.png.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  const tag = (at: number, t: string) => [...t].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  tag(0, 'icns');
  v.setUint32(4, total);
  let off = 8;
  for (const e of entries) {
    tag(off, e.type);
    v.setUint32(off + 4, 8 + e.png.length);
    out.set(e.png, off + 8);
    off += 8 + e.png.length;
  }
  return out;
}

/** Самая большая PNG-картинка из ICO/ICNS (для открытия файла). null — внутри только BMP. */
export function largestIconPng(data: Uint8Array, kind: 'ico' | 'icns'): Uint8Array | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const isPng = (o: number) => data[o] === 0x89 && data[o + 1] === 0x50 && data[o + 2] === 0x4e && data[o + 3] === 0x47;
  let best: { size: number; off: number; len: number } | null = null;
  if (kind === 'ico') {
    const n = v.getUint16(4, true);
    for (let i = 0; i < n; i++) {
      const e = 6 + i * 16;
      const size = data[e] || 256, len = v.getUint32(e + 8, true), off = v.getUint32(e + 12, true);
      if (off + len <= data.length && isPng(off) && (!best || size > best.size)) best = { size, off, len };
    }
  } else {
    let off = 8;
    while (off + 8 <= data.length) {
      const len = v.getUint32(off + 4);
      if (len < 8) break;
      if (isPng(off + 8) && (!best || len > best.len)) best = { size: len, off: off + 8, len: len - 8 };
      off += len;
    }
  }
  return best ? data.slice(best.off, best.off + best.len) : null;
}

// ---------- платформы ----------

export type IconPlatform = 'windows' | 'macos' | 'favicon' | 'ios' | 'android' | 'tauri' | 'png';

export interface IconOptions {
  platforms: IconPlatform[];
  /** Размеры кадров в .ico (Windows). */
  icoSizes: number[];
  /** Размеры для набора PNG. */
  pngSizes: number[];
  style: IconStyle;
  /** Форма macOS (Big Sur): поля ~10% и скругление ~22% — только для .icns. */
  macShape: boolean;
  /** Подложка для iOS и apple-touch-icon (прозрачность там запрещена). */
  opaqueColor: string;
  name: string;
}

export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

export const PLATFORMS: { id: IconPlatform; label: string; hint: string }[] = [
  { id: 'windows', label: 'Windows (.ico)', hint: 'один .ico с выбранными размерами' },
  { id: 'macos', label: 'macOS (.icns)', hint: '16–1024 px, обычные и @2x' },
  { id: 'favicon', label: 'Сайт (favicon)', hint: 'favicon.ico, PNG 16/32, apple-touch-icon, Android 192/512, site.webmanifest' },
  { id: 'ios', label: 'iOS (AppIcon)', hint: 'AppIcon.appiconset: 1024 px + Contents.json, без прозрачности' },
  { id: 'android', label: 'Android (mipmap)', hint: 'ic_launcher и ic_launcher_round для mdpi…xxxhdpi + 512 для Google Play' },
  { id: 'tauri', label: 'Tauri / Electron', hint: 'icons/: 32x32, 128x128, 128x128@2x, icon.png, icon.ico, icon.icns' },
  { id: 'png', label: 'Набор PNG', hint: 'icon_<размер>.png выбранных размеров' },
];

export const DEFAULT_ICON: IconOptions = {
  platforms: ['windows', 'macos'],
  icoSizes: [16, 24, 32, 48, 64, 128, 256],
  pngSizes: [16, 32, 64, 128, 256, 512, 1024],
  style: { padding: 0, radius: 0, background: null, smooth: true },
  macShape: false,
  opaqueColor: '#ffffff',
  name: 'icon',
};

/** Все файлы иконок для выбранных платформ (пути с папками). */
export async function buildIconFiles(src: HTMLCanvasElement, o: IconOptions): Promise<Record<string, Uint8Array>> {
  const cache = new Map<string, Uint8Array>();
  const png = async (size: number, st: IconStyle = o.style) => {
    const key = `${size}:${JSON.stringify(st)}`;
    if (!cache.has(key)) cache.set(key, await encodeCanvas(renderIcon(src, size, st), 'png'));
    return cache.get(key)!;
  };
  const opaque: IconStyle = { ...o.style, background: o.style.background ?? o.opaqueColor, radius: 0 };
  const mac: IconStyle = o.macShape ? { ...o.style, padding: Math.max(o.style.padding, 100 / 1024), radius: 0.2237 * (1 - 2 * Math.max(o.style.padding, 100 / 1024)) } : o.style;
  const ico = async (sizes: number[]) => encodeIco(await Promise.all([...sizes].sort((a, b) => a - b).map(async (size) => ({ size, png: await png(size) }))));
  const icns = async () => {
    const m = new Map<number, Uint8Array>();
    for (const s of ICNS_SIZES) m.set(s, await png(s, mac));
    return encodeIcns(m);
  };
  const enc = (t: string) => new TextEncoder().encode(t);
  const files: Record<string, Uint8Array> = {};
  const n = o.name || 'icon';
  for (const p of o.platforms) {
    if (p === 'windows') files[`${n}.ico`] = await ico(o.icoSizes.length ? o.icoSizes : [16, 32, 48, 256]);
    if (p === 'macos') files[`${n}.icns`] = await icns();
    if (p === 'png') for (const s of o.pngSizes) files[`png/${n}_${s}.png`] = await png(s);
    if (p === 'favicon') {
      files['favicon/favicon.ico'] = await ico([16, 32, 48]);
      files['favicon/favicon-16x16.png'] = await png(16);
      files['favicon/favicon-32x32.png'] = await png(32);
      files['favicon/apple-touch-icon.png'] = await png(180, opaque);
      files['favicon/android-chrome-192x192.png'] = await png(192);
      files['favicon/android-chrome-512x512.png'] = await png(512);
      files['favicon/site.webmanifest'] = enc(JSON.stringify({
        name: n, short_name: n,
        icons: [
          { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
        theme_color: o.opaqueColor, background_color: o.opaqueColor, display: 'standalone',
      }, null, 2));
      files['favicon/README.html.txt'] = enc([
        '<link rel="icon" href="/favicon.ico" sizes="any">',
        '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
        '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
        '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
        '<link rel="manifest" href="/site.webmanifest">',
        '',
      ].join('\n'));
    }
    if (p === 'ios') {
      files['AppIcon.appiconset/Icon-1024.png'] = await png(1024, opaque);
      files['AppIcon.appiconset/Contents.json'] = enc(JSON.stringify({
        images: [{ filename: 'Icon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
        info: { author: 'xcode', version: 1 },
      }, null, 2));
    }
    if (p === 'android') {
      const dens: [string, number][] = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
      for (const [d, s] of dens) {
        files[`android/mipmap-${d}/ic_launcher.png`] = await png(s);
        files[`android/mipmap-${d}/ic_launcher_round.png`] = await png(s, { ...o.style, radius: 0.5 });
      }
      files['android/playstore-icon.png'] = await png(512, { ...opaque, radius: o.style.radius });
    }
    if (p === 'tauri') {
      files['icons/32x32.png'] = await png(32);
      files['icons/128x128.png'] = await png(128);
      files['icons/128x128@2x.png'] = await png(256);
      files['icons/icon.png'] = await png(512);
      files['icons/icon.ico'] = await ico([16, 24, 32, 48, 64, 256]);
      files['icons/icon.icns'] = await icns();
    }
  }
  return files;
}
