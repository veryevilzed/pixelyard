import type { RGBA } from './types';

/**
 * Цветовые модели (HSB, HSL, Lab, CMYK) и цветовые гармонии для круга подбора.
 * RGB — 0..255, H — 0..360, S/B/L — 0..1, Lab — L 0..100, a/b ≈ −128..127, CMYK — 0..1.
 */

export type HSB = [number, number, number];

export function rgbToHsb([r, g, b]: RGBA | [number, number, number]): HSB {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

export function hsbToRgb(h: number, s: number, v: number, a = 255): RGBA {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return [f(5), f(3), f(1), a];
}

export function rgbToHsl([r, g, b]: RGBA | [number, number, number]): [number, number, number] {
  const [h, s, v] = rgbToHsb([r, g, b]);
  const l = v * (1 - s / 2);
  return [h, l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l];
}

export function hslToRgb(h: number, s: number, l: number, a = 255): RGBA {
  const v = l + s * Math.min(l, 1 - l);
  return hsbToRgb(h, v ? 2 * (1 - l / v) : 0, v, a);
}

// sRGB (D65) ↔ CIE Lab
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const fLab = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (t * 24389) / 27 / 116 + 16 / 116);
const fInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
const WX = 0.95047, WZ = 1.08883;

export function rgbToLab([r, g, b]: RGBA | [number, number, number]): [number, number, number] {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / WX;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / WZ;
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L: number, a: number, b: number, alpha = 255): RGBA {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = fInv(fx) * WX, y = fInv(fy), z = fInv(fz) * WZ;
  const R = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const G = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const B = x * 0.0557 + y * -0.204 + z * 1.057;
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, gam(v))) * 255);
  return [c(R), c(G), c(B), alpha];
}

/** Простой CMYK (без цветового профиля) — для ориентира, как «по умолчанию» в редакторах. */
export function rgbToCmyk([r, g, b]: RGBA | [number, number, number]): [number, number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const k = 1 - Math.max(R, G, B);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - R - k) / (1 - k), (1 - G - k) / (1 - k), (1 - B - k) / (1 - k), k];
}

export function cmykToRgb(c: number, m: number, y: number, k: number, a = 255): RGBA {
  return [Math.round(255 * (1 - c) * (1 - k)), Math.round(255 * (1 - m) * (1 - k)), Math.round(255 * (1 - y) * (1 - k)), a];
}

export const hex = ([r, g, b]: RGBA | [number, number, number]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

export function parseHex(s: string, a = 255): RGBA | null {
  const m = s.trim().replace(/^#/, '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

// ---------- гармонии ----------

export type Harmony = 'complementary' | 'analogous' | 'triad' | 'split' | 'tetrad' | 'square' | 'monochrome';

export const HARMONIES: { id: Harmony; label: string }[] = [
  { id: 'complementary', label: 'Комплементарная' },
  { id: 'analogous', label: 'Аналоговая' },
  { id: 'triad', label: 'Триада' },
  { id: 'split', label: 'Раздельная' },
  { id: 'tetrad', label: 'Тетрада' },
  { id: 'square', label: 'Квадрат' },
  { id: 'monochrome', label: 'Монохром' },
];

/** Смещения тона от базового (градусы) для схемы; spread — раствор для аналоговой/раздельной/тетрады. */
export function harmonyOffsets(h: Harmony, spread: number): number[] {
  switch (h) {
    case 'complementary': return [0, 180];
    case 'analogous': return [-spread, 0, spread];
    case 'triad': return [0, 120, 240];
    case 'split': return [0, 180 - spread, 180 + spread];
    case 'tetrad': return [0, spread, 180, 180 + spread];
    case 'square': return [0, 90, 180, 270];
    default: return [0];
  }
}

/** Цвета схемы: тона по кругу при общей насыщенности и яркости; монохром — по яркости. */
export function harmonyColors(base: HSB, h: Harmony, spread: number): RGBA[] {
  if (h === 'monochrome') {
    const [hu, s] = base;
    return [0.25, 0.45, 0.65, 0.82, 1].map((v, i) => hsbToRgb(hu, Math.max(0.15, s * (i < 3 ? 1 : 0.7)), v));
  }
  return harmonyOffsets(h, spread).map((d) => hsbToRgb((base[0] + d + 360) % 360, base[1], base[2]));
}

// ---------- свои палитры ----------

export interface Palette {
  id: string;
  name: string;
  colors: RGBA[];
}

/** GIMP / Inkscape .gpl */
export function encodeGpl(p: Palette): string {
  return ['GIMP Palette', `Name: ${p.name}`, 'Columns: 8', '#', ...p.colors.map((c) => `${String(c[0]).padStart(3)} ${String(c[1]).padStart(3)} ${String(c[2]).padStart(3)}\t${hex(c)}`), ''].join('\n');
}

export function decodeGpl(text: string, fallbackName: string): { name: string; colors: RGBA[] } {
  let name = fallbackName;
  const colors: RGBA[] = [];
  for (const line of text.split(/\r?\n/)) {
    const n = /^Name:\s*(.+)$/.exec(line);
    if (n) name = n[1].trim();
    const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
    if (m) colors.push([+m[1], +m[2], +m[3], 255]);
  }
  if (!colors.length) throw new Error('В файле нет цветов (ожидается палитра GIMP .gpl)');
  return { name, colors };
}
