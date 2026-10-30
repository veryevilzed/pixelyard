import type { RGBA } from './types';

export type ParamDef =
  | { key: string; label: string; type: 'range'; min: number; max: number; step?: number; default: number }
  | { key: string; label: string; type: 'color'; default: RGBA }
  | { key: string; label: string; type: 'check'; default: boolean }
  | { key: string; label: string; type: 'select'; options: { id: string; label: string }[]; default: string };

/** Кривые: точки (вход → выход, 0..255) для общего RGB и каждого канала. */
export interface CurvesData {
  rgb: [number, number][];
  r: [number, number][];
  g: [number, number][];
  b: [number, number][];
}

export type Params = Record<string, number | boolean | RGBA | string | CurvesData>;

export interface FilterDef {
  id: string;
  label: string;
  group: 'adjust' | 'filter' | 'auto';
  params: ParamDef[];
  /** Меняет img на месте или возвращает новое изображение. */
  apply(img: ImageData, p: Params): ImageData | void;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const num = (p: Params, k: string) => p[k] as number;

function mapRGB(img: ImageData, fn: (r: number, g: number, b: number) => [number, number, number]) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [r, g, b] = fn(d[i], d[i + 1], d[i + 2]);
    d[i] = clamp255(r);
    d[i + 1] = clamp255(g);
    d[i + 2] = clamp255(b);
  }
}

function lut(fn: (v: number) => number): Uint8ClampedArray {
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = fn(i);
  return t;
}

function applyLut(img: ImageData, t: Uint8ClampedArray) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = t[d[i]];
    d[i + 1] = t[d[i + 1]];
    d[i + 2] = t[d[i + 2]];
  }
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/** Трёхпроходное box-размытие ≈ гауссово; работает с премультиплицированной альфой. */
export function blurImageData(img: ImageData, radius: number): ImageData {
  const r = Math.max(0, Math.round(radius));
  if (!r) return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    ch[0][i] = data[i * 4] * a;
    ch[1][i] = data[i * 4 + 1] * a;
    ch[2][i] = data[i * 4 + 2] * a;
    ch[3][i] = data[i * 4 + 3];
  }
  // радиусы трёх box-проходов для приближения гаусса с sigma ≈ r/2
  const sigma = r / 2 + 0.5;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  const boxes = [0, 1, 2].map((i) => ((i < m ? wl : wl + 2) - 1) / 2);
  const tmp = new Float32Array(n);
  const boxH = (src: Float32Array, dst: Float32Array, br: number) => {
    const iarr = 1 / (br + br + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -br - 1; k < br; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        acc += src[row + Math.min(w - 1, x + br)] - src[row + Math.max(0, x - br - 1)];
        dst[row + x] = acc * iarr;
      }
    }
  };
  const boxV = (src: Float32Array, dst: Float32Array, br: number) => {
    const iarr = 1 / (br + br + 1);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -br - 1; k < br; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        acc += src[Math.min(h - 1, y + br) * w + x] - src[Math.max(0, y - br - 1) * w + x];
        dst[y * w + x] = acc * iarr;
      }
    }
  };
  for (const c of ch) {
    for (const br of boxes) {
      boxH(c, tmp, br);
      boxV(tmp, c, br);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = ch[3][i];
    data[i * 4 + 3] = clamp255(a);
    const k = a > 0 ? 255 / a : 0;
    data[i * 4] = clamp255(ch[0][i] * k);
    data[i * 4 + 1] = clamp255(ch[1][i] * k);
    data[i * 4 + 2] = clamp255(ch[2][i] * k);
  }
  return img;
}

/** Расширение альфа-канала на radius пикселей (для обводки). */
export function dilateAlpha(alpha: Uint8ClampedArray, w: number, h: number, radius: number): Float32Array {
  const INF = 1e9;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = alpha[i] > 127 ? 0 : INF;
  const relax = (i: number, j: number, c: number) => {
    if (dist[j] + c < dist[i]) dist[i] = dist[j] + c;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - w, 1);
        if (x > 0) relax(i, i - w - 1, Math.SQRT2);
        if (x < w - 1) relax(i, i - w + 1, Math.SQRT2);
      }
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, i + 1, 1);
      if (y < h - 1) {
        relax(i, i + w, 1);
        if (x < w - 1) relax(i, i + w + 1, Math.SQRT2);
        if (x > 0) relax(i, i + w - 1, Math.SQRT2);
      }
    }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.max(0, Math.min(1, radius + 0.5 - dist[i]));
  return out;
}

export const FILTERS: FilterDef[] = [
  {
    id: 'brightness-contrast',
    label: 'Яркость/Контраст…',
    group: 'adjust',
    params: [
      { key: 'brightness', label: 'Яркость', type: 'range', min: -150, max: 150, default: 0 },
      { key: 'contrast', label: 'Контраст', type: 'range', min: -100, max: 100, default: 0 },
    ],
    apply(img, p) {
      const b = num(p, 'brightness');
      const c = num(p, 'contrast');
      const f = (259 * (c + 255)) / (255 * (259 - c));
      applyLut(img, lut((v) => f * (v + b - 128) + 128));
    },
  },
  {
    id: 'hue-saturation',
    label: 'Цветовой тон/Насыщенность…',
    group: 'adjust',
    params: [
      { key: 'hue', label: 'Цветовой тон', type: 'range', min: -180, max: 180, default: 0 },
      { key: 'sat', label: 'Насыщенность', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'light', label: 'Яркость', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'colorize', label: 'Тонирование', type: 'check', default: false },
    ],
    apply(img, p) {
      const dh = num(p, 'hue'), ds = num(p, 'sat') / 100, dl = num(p, 'light') / 100;
      const colorize = p.colorize as boolean;
      mapRGB(img, (r, g, b) => {
        let [h, s, l] = rgbToHsl(r, g, b);
        if (colorize) {
          h = (dh + 360) % 360;
          s = Math.max(0, Math.min(1, 0.5 + ds / 2));
        } else {
          h += dh;
          s = ds > 0 ? s + (1 - s) * ds : s * (1 + ds);
        }
        l = dl > 0 ? l + (1 - l) * dl : l * (1 + dl);
        return hslToRgb(h, s, l);
      });
    },
  },
  {
    id: 'levels',
    label: 'Уровни…',
    group: 'adjust',
    params: [
      { key: 'inBlack', label: 'Вход: чёрная точка', type: 'range', min: 0, max: 254, default: 0 },
      { key: 'inWhite', label: 'Вход: белая точка', type: 'range', min: 1, max: 255, default: 255 },
      { key: 'gamma', label: 'Гамма', type: 'range', min: 0.1, max: 5, step: 0.01, default: 1 },
      { key: 'outBlack', label: 'Выход: чёрная', type: 'range', min: 0, max: 255, default: 0 },
      { key: 'outWhite', label: 'Выход: белая', type: 'range', min: 0, max: 255, default: 255 },
    ],
    apply(img, p) {
      const ib = num(p, 'inBlack'), iw = Math.max(ib + 1, num(p, 'inWhite'));
      const g = num(p, 'gamma'), ob = num(p, 'outBlack'), ow = num(p, 'outWhite');
      applyLut(img, lut((v) => {
        const t = Math.max(0, Math.min(1, (v - ib) / (iw - ib)));
        return ob + Math.pow(t, 1 / g) * (ow - ob);
      }));
    },
  },
  {
    id: 'color-balance',
    label: 'Цветовой баланс…',
    group: 'adjust',
    params: [
      { key: 'r', label: 'Голубой ↔ Красный', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'g', label: 'Пурпурный ↔ Зелёный', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'b', label: 'Жёлтый ↔ Синий', type: 'range', min: -100, max: 100, default: 0 },
    ],
    apply(img, p) {
      const dr = num(p, 'r'), dg = num(p, 'g'), db = num(p, 'b');
      mapRGB(img, (r, g, b) => [r + dr, g + dg, b + db]);
    },
  },
  {
    id: 'exposure',
    label: 'Экспозиция и гамма…',
    group: 'adjust',
    params: [
      { key: 'exposure', label: 'Экспозиция (EV)', type: 'range', min: -3, max: 3, step: 0.05, default: 0 },
      { key: 'gamma', label: 'Гамма', type: 'range', min: 0.2, max: 3, step: 0.01, default: 1 },
    ],
    apply(img, p) {
      const k = Math.pow(2, num(p, 'exposure')), g = num(p, 'gamma');
      applyLut(img, lut((v) => 255 * Math.pow(Math.min(1, (v / 255) * k), 1 / g)));
    },
  },
  {
    id: 'invert',
    label: 'Инверсия',
    group: 'adjust',
    params: [],
    apply(img) {
      applyLut(img, lut((v) => 255 - v));
    },
  },
  {
    id: 'desaturate',
    label: 'Обесцветить',
    group: 'adjust',
    params: [],
    apply(img) {
      mapRGB(img, (r, g, b) => {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return [y, y, y];
      });
    },
  },
  {
    id: 'posterize',
    label: 'Постеризация…',
    group: 'adjust',
    params: [{ key: 'levels', label: 'Уровни', type: 'range', min: 2, max: 32, default: 6 }],
    apply(img, p) {
      const n = num(p, 'levels') - 1;
      applyLut(img, lut((v) => (Math.round((v / 255) * n) / n) * 255));
    },
  },
  {
    id: 'threshold',
    label: 'Порог…',
    group: 'adjust',
    params: [{ key: 'level', label: 'Порог', type: 'range', min: 1, max: 255, default: 128 }],
    apply(img, p) {
      const t = num(p, 'level');
      mapRGB(img, (r, g, b) => {
        const v = 0.2126 * r + 0.7152 * g + 0.0722 * b >= t ? 255 : 0;
        return [v, v, v];
      });
    },
  },
  {
    id: 'blur',
    label: 'Размытие по Гауссу…',
    group: 'filter',
    params: [{ key: 'radius', label: 'Радиус', type: 'range', min: 1, max: 100, default: 4 }],
    apply(img, p) {
      return blurImageData(img, num(p, 'radius'));
    },
  },
  {
    id: 'sharpen',
    label: 'Контурная резкость…',
    group: 'filter',
    params: [
      { key: 'amount', label: 'Эффект, %', type: 'range', min: 1, max: 500, default: 100 },
      { key: 'radius', label: 'Радиус', type: 'range', min: 1, max: 20, default: 1 },
    ],
    apply(img, p) {
      const blurred = blurImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), num(p, 'radius'));
      const k = num(p, 'amount') / 100;
      const d = img.data, bd = blurred.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp255(d[i] + (d[i] - bd[i]) * k);
        d[i + 1] = clamp255(d[i + 1] + (d[i + 1] - bd[i + 1]) * k);
        d[i + 2] = clamp255(d[i + 2] + (d[i + 2] - bd[i + 2]) * k);
      }
    },
  },
  {
    id: 'pixelate',
    label: 'Пикселизация…',
    group: 'filter',
    params: [{ key: 'size', label: 'Размер ячейки', type: 'range', min: 2, max: 128, default: 8 }],
    apply(img, p) {
      const s = num(p, 'size');
      const { width: w, height: h, data: d } = img;
      for (let by = 0; by < h; by += s)
        for (let bx = 0; bx < w; bx += s) {
          let r = 0, g = 0, b = 0, a = 0, n = 0;
          for (let y = by; y < Math.min(h, by + s); y++)
            for (let x = bx; x < Math.min(w, bx + s); x++) {
              const i = (y * w + x) * 4, al = d[i + 3];
              r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; n++;
            }
          const ia = a ? 1 / a : 0;
          for (let y = by; y < Math.min(h, by + s); y++)
            for (let x = bx; x < Math.min(w, bx + s); x++) {
              const i = (y * w + x) * 4;
              d[i] = r * ia; d[i + 1] = g * ia; d[i + 2] = b * ia; d[i + 3] = a / n;
            }
        }
    },
  },
  {
    id: 'color-to-alpha',
    label: 'Цвет в прозрачность…',
    group: 'filter',
    params: [
      { key: 'color', label: 'Цвет', type: 'color', default: [255, 255, 255, 255] },
      { key: 'threshold', label: 'Порог (полностью прозрачно)', type: 'range', min: 0, max: 255, default: 0 },
    ],
    apply(img, p) {
      // Алгоритм как в GIMP: минимальная альфа, при которой пиксель = смесь цвета и ключа.
      const [kr, kg, kb] = p.color as RGBA;
      const thr = num(p, 'threshold') / 255;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const src = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
        const key = [kr / 255, kg / 255, kb / 255];
        let alpha = 0;
        for (let c = 0; c < 3; c++) {
          const diff = src[c] - key[c];
          const a = diff > 0 ? diff / (1 - key[c] || 1) : diff < 0 ? -diff / (key[c] || 1) : 0;
          if (a > alpha) alpha = a;
        }
        if (alpha <= thr) alpha = 0;
        const out = d[i + 3] / 255 * alpha;
        if (alpha > 0) {
          for (let c = 0; c < 3; c++) d[i + c] = clamp255(((src[c] - key[c]) / alpha + key[c]) * 255);
        }
        d[i + 3] = out * 255;
      }
    },
  },
  {
    id: 'alpha-threshold',
    label: 'Порог альфы (чистые края)…',
    group: 'filter',
    params: [{ key: 'level', label: 'Порог', type: 'range', min: 1, max: 254, default: 128 }],
    apply(img, p) {
      const t = num(p, 'level');
      const d = img.data;
      for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= t ? 255 : 0;
    },
  },
  {
    id: 'outline',
    label: 'Обводка контура…',
    group: 'filter',
    params: [
      { key: 'size', label: 'Толщина', type: 'range', min: 1, max: 64, default: 2 },
      { key: 'color', label: 'Цвет', type: 'color', default: [0, 0, 0, 255] },
    ],
    apply(img, p) {
      const { width: w, height: h, data: d } = img;
      const alpha = new Uint8ClampedArray(w * h);
      for (let i = 0; i < w * h; i++) alpha[i] = d[i * 4 + 3];
      const cover = dilateAlpha(alpha, w, h, num(p, 'size'));
      const [cr, cg, cb, ca] = p.color as RGBA;
      // обводка кладётся «под» исходные пиксели
      for (let i = 0; i < w * h; i++) {
        const sa = d[i * 4 + 3] / 255;
        const oa = (cover[i] * ca) / 255;
        const outA = sa + oa * (1 - sa);
        if (outA <= 0) continue;
        d[i * 4] = (d[i * 4] * sa + cr * oa * (1 - sa)) / outA;
        d[i * 4 + 1] = (d[i * 4 + 1] * sa + cg * oa * (1 - sa)) / outA;
        d[i * 4 + 2] = (d[i * 4 + 2] * sa + cb * oa * (1 - sa)) / outA;
        d[i * 4 + 3] = outA * 255;
      }
    },
  },
  {
    id: 'drop-shadow',
    label: 'Тень…',
    group: 'filter',
    params: [
      { key: 'dx', label: 'Смещение X', type: 'range', min: -64, max: 64, default: 4 },
      { key: 'dy', label: 'Смещение Y', type: 'range', min: -64, max: 64, default: 4 },
      { key: 'blur', label: 'Размытие', type: 'range', min: 0, max: 50, default: 4 },
      { key: 'opacity', label: 'Непрозрачность, %', type: 'range', min: 0, max: 100, default: 60 },
      { key: 'color', label: 'Цвет', type: 'color', default: [0, 0, 0, 255] },
    ],
    apply(img, p) {
      const { width: w, height: h, data: d } = img;
      const [cr, cg, cb] = p.color as RGBA;
      const dx = num(p, 'dx'), dy = num(p, 'dy');
      const shadow = new ImageData(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = x - dx, sy = y - dy;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const i = (y * w + x) * 4;
          shadow.data[i] = cr; shadow.data[i + 1] = cg; shadow.data[i + 2] = cb;
          shadow.data[i + 3] = d[(sy * w + sx) * 4 + 3];
        }
      blurImageData(shadow, num(p, 'blur'));
      const op = num(p, 'opacity') / 100;
      const s = shadow.data;
      for (let i = 0; i < d.length; i += 4) {
        const sa = d[i + 3] / 255, oa = (s[i + 3] / 255) * op;
        const outA = sa + oa * (1 - sa);
        if (outA <= 0) continue;
        for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] * sa + s[i + c] * oa * (1 - sa)) / outA;
        d[i + 3] = outA * 255;
      }
    },
  },
];

export function defaultParams(f: FilterDef): Params {
  const p: Params = {};
  for (const d of f.params) p[d.key] = d.default;
  return p;
}

// ---------- кривые ----------

/**
 * Монотонный кубический сплайн (Фриче–Карлсон) через точки кривой → таблица 0..255.
 * Монотонность важна: кривая не «выстреливает» между точками, как обычный сплайн.
 */
export function curveLut(points: [number, number][]): Uint8ClampedArray {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const t = new Uint8ClampedArray(256);
  if (pts.length === 0) {
    for (let i = 0; i < 256; i++) t[i] = i;
    return t;
  }
  if (pts.length === 1) {
    t.fill(pts[0][1]);
    return t;
  }
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      m[i] = k * a * d[i];
      m[i + 1] = k * b * d[i];
    }
  }
  for (let x = 0; x < 256; x++) {
    let y: number;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      let i = 0;
      while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], s = (x - xs[i]) / h;
      const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
      y = h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
    }
    t[x] = y;
  }
  return t;
}

export const IDENTITY_CURVES: CurvesData = { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] };

export function applyCurves(img: ImageData, c: CurvesData) {
  const all = curveLut(c.rgb), lr = curveLut(c.r), lg = curveLut(c.g), lb = curveLut(c.b);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = all[lr[d[i]]];
    d[i + 1] = all[lg[d[i + 1]]];
    d[i + 2] = all[lb[d[i + 2]]];
  }
}

/** Гистограмма по каналам (только непрозрачные пиксели). */
export function histogram(img: ImageData) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    r[d[i]]++;
    g[d[i + 1]]++;
    b[d[i + 2]]++;
    l[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  }
  return { r, g, b, l };
}

// ---------- авто-коррекции ----------

/** Границы гистограммы с отсечением clip доли самых тёмных/светлых пикселей. */
function bounds(h: Uint32Array, clip: number): [number, number] {
  const total = h.reduce((s, v) => s + v, 0);
  if (!total) return [0, 255];
  const cut = total * clip;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && acc + h[lo] <= cut) acc += h[lo++];
  acc = 0;
  while (hi > 0 && acc + h[hi] <= cut) acc += h[hi--];
  return hi > lo ? [lo, hi] : [0, 255];
}

function stretch(lo: number, hi: number) {
  return lut((v) => ((v - lo) / (hi - lo)) * 255);
}

/** Автотон: растяжение каждого канала отдельно (может сдвинуть цвет). */
export function autoTone(img: ImageData) {
  const h = histogram(img);
  const [rl, rh] = bounds(h.r, 0.001), [gl, gh] = bounds(h.g, 0.001), [bl, bh] = bounds(h.b, 0.001);
  const tr = stretch(rl, rh), tg = stretch(gl, gh), tb = stretch(bl, bh);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = tr[d[i]];
    d[i + 1] = tg[d[i + 1]];
    d[i + 2] = tb[d[i + 2]];
  }
}

/** Автоконтраст: одинаковое растяжение всех каналов — цвета не меняются. */
export function autoContrast(img: ImageData) {
  const h = histogram(img);
  const [lo, hi] = bounds(h.l, 0.001);
  applyLut(img, stretch(lo, hi));
}

/** Автоцвет: растяжение по каналам + нейтрализация среднего тона (серый мир). */
export function autoColor(img: ImageData) {
  autoTone(img);
  const d = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  if (!n) return;
  const avg = (r + g + b) / (3 * n);
  const kr = avg / (r / n || 1), kg = avg / (g / n || 1), kb = avg / (b / n || 1);
  // гамма-сдвиг вместо умножения: не выбивает света
  const gr = lut((v) => 255 * Math.pow(v / 255, 1 / Math.max(0.5, Math.min(2, kr))));
  const gg = lut((v) => 255 * Math.pow(v / 255, 1 / Math.max(0.5, Math.min(2, kg))));
  const gb = lut((v) => 255 * Math.pow(v / 255, 1 / Math.max(0.5, Math.min(2, kb))));
  for (let i = 0; i < d.length; i += 4) {
    d[i] = gr[d[i]];
    d[i + 1] = gg[d[i + 1]];
    d[i + 2] = gb[d[i + 2]];
  }
}

const lumOf = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

const TONE_OPTIONS = [
  { id: 'shadows', label: 'Тени' },
  { id: 'midtones', label: 'Средние тона' },
  { id: 'highlights', label: 'Света' },
];

const SELECTIVE_OPTIONS = [
  { id: 'reds', label: 'Красные' },
  { id: 'yellows', label: 'Жёлтые' },
  { id: 'greens', label: 'Зелёные' },
  { id: 'cyans', label: 'Голубые' },
  { id: 'blues', label: 'Синие' },
  { id: 'magentas', label: 'Пурпурные' },
  { id: 'whites', label: 'Белые' },
  { id: 'neutrals', label: 'Нейтральные' },
  { id: 'blacks', label: 'Чёрные' },
];

FILTERS.push(
  {
    id: 'curves',
    label: 'Кривые…',
    group: 'adjust',
    params: [],
    apply(img, p) {
      applyCurves(img, (p.curves as CurvesData) ?? IDENTITY_CURVES);
    },
  },
  {
    id: 'vibrance',
    label: 'Сочность…',
    group: 'adjust',
    params: [
      { key: 'vibrance', label: 'Сочность', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'saturation', label: 'Насыщенность', type: 'range', min: -100, max: 100, default: 0 },
    ],
    apply(img, p) {
      const vib = num(p, 'vibrance') / 100, sat = num(p, 'saturation') / 100;
      mapRGB(img, (r, g, b) => {
        // сочность сильнее действует на малонасыщенные цвета и бережёт уже яркие
        const mx = Math.max(r, g, b), avg = (r + g + b) / 3;
        const amt = (1 - ((mx - avg) * 2) / 255) * vib;
        const l1 = lumOf(r, g, b);
        r = l1 + (r - l1) * (1 + amt);
        g = l1 + (g - l1) * (1 + amt);
        b = l1 + (b - l1) * (1 + amt);
        const l2 = lumOf(r, g, b);
        return [l2 + (r - l2) * (1 + sat), l2 + (g - l2) * (1 + sat), l2 + (b - l2) * (1 + sat)];
      });
    },
  },
  {
    id: 'black-white',
    label: 'Чёрно-белое…',
    group: 'adjust',
    params: [
      { key: 'reds', label: 'Красные', type: 'range', min: -200, max: 300, default: 40 },
      { key: 'yellows', label: 'Жёлтые', type: 'range', min: -200, max: 300, default: 60 },
      { key: 'greens', label: 'Зелёные', type: 'range', min: -200, max: 300, default: 40 },
      { key: 'cyans', label: 'Голубые', type: 'range', min: -200, max: 300, default: 60 },
      { key: 'blues', label: 'Синие', type: 'range', min: -200, max: 300, default: 20 },
      { key: 'magentas', label: 'Пурпурные', type: 'range', min: -200, max: 300, default: 80 },
      { key: 'tint', label: 'Тонирование', type: 'check', default: false },
      { key: 'tintColor', label: 'Цвет тона', type: 'color', default: [225, 211, 179, 255] },
    ],
    apply(img, p) {
      // формула как в Photoshop: min + (max−mid)·W[основной] + (mid−min)·W[вторичный]
      const W = { r: num(p, 'reds') / 100, y: num(p, 'yellows') / 100, g: num(p, 'greens') / 100, c: num(p, 'cyans') / 100, b: num(p, 'blues') / 100, m: num(p, 'magentas') / 100 };
      const tint = p.tint as boolean;
      const [tr, tg, tb] = p.tintColor as RGBA;
      mapRGB(img, (r, g, b) => {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), md = r + g + b - mx - mn;
        let primary: number, secondary: number;
        if (mx === r) {
          primary = W.r;
          secondary = md === g ? W.y : W.m;
        } else if (mx === g) {
          primary = W.g;
          secondary = md === r ? W.y : W.c;
        } else {
          primary = W.b;
          secondary = md === g ? W.c : W.m;
        }
        const v = mn + (mx - md) * primary + (md - mn) * secondary;
        if (!tint) return [v, v, v];
        // тонирование: цвет тона накладывается на серый в режиме «перекрытие»
        const ov = (t: number) => (v < 128 ? (2 * v * t) / 255 : 255 - (2 * (255 - v) * (255 - t)) / 255);
        return [ov(tr), ov(tg), ov(tb)];
      });
    },
  },
  {
    id: 'photo-filter',
    label: 'Фотофильтр…',
    group: 'adjust',
    params: [
      { key: 'color', label: 'Цвет фильтра', type: 'color', default: [236, 138, 0, 255] },
      { key: 'density', label: 'Плотность, %', type: 'range', min: 0, max: 100, default: 25 },
      { key: 'preserve', label: 'Сохранять яркость', type: 'check', default: true },
    ],
    apply(img, p) {
      const [fr, fg, fb] = p.color as RGBA;
      const k = num(p, 'density') / 100;
      const preserve = p.preserve as boolean;
      mapRGB(img, (r, g, b) => {
        let nr = r + (r * (fr / 255) - r) * k + (fr - r) * k * 0.25;
        let ng = g + (g * (fg / 255) - g) * k + (fg - g) * k * 0.25;
        let nb = b + (b * (fb / 255) - b) * k + (fb - b) * k * 0.25;
        if (preserve) {
          const dl = lumOf(r, g, b) - lumOf(nr, ng, nb);
          nr += dl;
          ng += dl;
          nb += dl;
        }
        return [nr, ng, nb];
      });
    },
  },
  {
    id: 'white-balance',
    label: 'Температура и оттенок…',
    group: 'adjust',
    params: [
      { key: 'temp', label: 'Температура (холоднее ↔ теплее)', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'tint', label: 'Оттенок (зелёный ↔ пурпурный)', type: 'range', min: -100, max: 100, default: 0 },
    ],
    apply(img, p) {
      const t = num(p, 'temp') / 100, n = num(p, 'tint') / 100;
      const kr = 1 + t * 0.35, kb = 1 - t * 0.35, kg = 1 - n * 0.3;
      const krm = 1 + n * 0.12, kbm = 1 + n * 0.12;
      mapRGB(img, (r, g, b) => [r * kr * krm, g * kg, b * kb * kbm]);
    },
  },
  {
    id: 'color-balance-tones',
    label: 'Цветовой баланс по тонам…',
    group: 'adjust',
    params: [
      { key: 'tone', label: 'Диапазон', type: 'select', options: TONE_OPTIONS, default: 'midtones' },
      { key: 'r', label: 'Голубой ↔ Красный', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'g', label: 'Пурпурный ↔ Зелёный', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'b', label: 'Жёлтый ↔ Синий', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'preserve', label: 'Сохранять яркость', type: 'check', default: true },
    ],
    apply(img, p) {
      const tone = p.tone as string;
      const dr = num(p, 'r'), dg = num(p, 'g'), db = num(p, 'b');
      const preserve = p.preserve as boolean;
      mapRGB(img, (r, g, b) => {
        const L = lumOf(r, g, b) / 255;
        const w = tone === 'shadows' ? Math.max(0, 1 - L * 2) : tone === 'highlights' ? Math.max(0, L * 2 - 1) : 1 - Math.abs(L - 0.5) * 2;
        let nr = r + dr * w, ng = g + dg * w, nb = b + db * w;
        if (preserve) {
          const dl = lumOf(r, g, b) - lumOf(nr, ng, nb);
          nr += dl;
          ng += dl;
          nb += dl;
        }
        return [nr, ng, nb];
      });
    },
  },
  {
    id: 'channel-mixer',
    label: 'Микширование каналов…',
    group: 'adjust',
    params: [
      { key: 'rr', label: 'Красный ← R, %', type: 'range', min: -200, max: 200, default: 100 },
      { key: 'rg', label: 'Красный ← G, %', type: 'range', min: -200, max: 200, default: 0 },
      { key: 'rb', label: 'Красный ← B, %', type: 'range', min: -200, max: 200, default: 0 },
      { key: 'gr', label: 'Зелёный ← R, %', type: 'range', min: -200, max: 200, default: 0 },
      { key: 'gg', label: 'Зелёный ← G, %', type: 'range', min: -200, max: 200, default: 100 },
      { key: 'gb', label: 'Зелёный ← B, %', type: 'range', min: -200, max: 200, default: 0 },
      { key: 'br', label: 'Синий ← R, %', type: 'range', min: -200, max: 200, default: 0 },
      { key: 'bg', label: 'Синий ← G, %', type: 'range', min: -200, max: 200, default: 0 },
      { key: 'bb', label: 'Синий ← B, %', type: 'range', min: -200, max: 200, default: 100 },
      { key: 'mono', label: 'Монохромный (по красному каналу)', type: 'check', default: false },
    ],
    apply(img, p) {
      const k = (key: string) => num(p, key) / 100;
      const mono = p.mono as boolean;
      mapRGB(img, (r, g, b) => {
        const nr = r * k('rr') + g * k('rg') + b * k('rb');
        if (mono) return [nr, nr, nr];
        return [nr, r * k('gr') + g * k('gg') + b * k('gb'), r * k('br') + g * k('bg') + b * k('bb')];
      });
    },
  },
  {
    id: 'gradient-map',
    label: 'Карта градиента…',
    group: 'adjust',
    params: [
      { key: 'from', label: 'Тени →', type: 'color', default: [20, 10, 60, 255] },
      { key: 'mid', label: 'Средние тона →', type: 'color', default: [200, 60, 90, 255] },
      { key: 'to', label: 'Света →', type: 'color', default: [255, 230, 160, 255] },
      { key: 'useMid', label: 'Использовать средний цвет', type: 'check', default: true },
      { key: 'reverse', label: 'Инверсия', type: 'check', default: false },
    ],
    apply(img, p) {
      const a = p.from as RGBA, m = p.mid as RGBA, z = p.to as RGBA;
      const useMid = p.useMid as boolean, rev = p.reverse as boolean;
      const at = (t: number): [number, number, number] => {
        if (rev) t = 1 - t;
        const lerp = (c0: RGBA, c1: RGBA, k: number): [number, number, number] => [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
        if (!useMid) return lerp(a, z, t);
        return t < 0.5 ? lerp(a, m, t * 2) : lerp(m, z, (t - 0.5) * 2);
      };
      const table = Array.from({ length: 256 }, (_, i) => at(i / 255));
      mapRGB(img, (r, g, b) => table[Math.round(lumOf(r, g, b))]);
    },
  },
  {
    id: 'shadows-highlights',
    label: 'Тени/Света…',
    group: 'adjust',
    params: [
      { key: 'shadows', label: 'Тени: осветлить, %', type: 'range', min: 0, max: 100, default: 35 },
      { key: 'highlights', label: 'Света: затемнить, %', type: 'range', min: 0, max: 100, default: 0 },
      { key: 'radius', label: 'Радиус', type: 'range', min: 1, max: 100, default: 20 },
    ],
    apply(img, p) {
      const sA = num(p, 'shadows') / 100, hA = num(p, 'highlights') / 100;
      const { width: w, height: h, data: d } = img;
      // размытая яркость — тени/света определяются по окрестности, а не по пикселю
      const lum = new ImageData(w, h);
      for (let i = 0; i < d.length; i += 4) {
        const l = lumOf(d[i], d[i + 1], d[i + 2]);
        lum.data[i] = lum.data[i + 1] = lum.data[i + 2] = l;
        lum.data[i + 3] = 255;
      }
      blurImageData(lum, num(p, 'radius'));
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const L = lum.data[i] / 255;
        const ws = Math.pow(1 - L, 2) * sA, wh = Math.pow(L, 2) * hA;
        for (let c = 0; c < 3; c++) {
          let v = d[i + c];
          v = v + (255 - v) * ws * 0.9;
          v = v - v * wh * 0.6;
          d[i + c] = clamp255(v);
        }
      }
    },
  },
  {
    id: 'selective-color',
    label: 'Выборочная коррекция цвета…',
    group: 'adjust',
    params: [
      { key: 'range', label: 'Цвета', type: 'select', options: SELECTIVE_OPTIONS, default: 'reds' },
      { key: 'cyan', label: 'Голубой', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'magenta', label: 'Пурпурный', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'yellow', label: 'Жёлтый', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'black', label: 'Чёрный', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'relative', label: 'Относительно (иначе абсолютно)', type: 'check', default: true },
    ],
    apply(img, p) {
      const range = p.range as string;
      const C = num(p, 'cyan') / 100, M = num(p, 'magenta') / 100, Y = num(p, 'yellow') / 100, K = num(p, 'black') / 100;
      const rel = p.relative as boolean;
      mapRGB(img, (r, g, b) => {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), md = r + g + b - mx - mn;
        // сколько пиксель «принадлежит» выбранному диапазону (как в Photoshop)
        let amt = 0;
        if (range === 'reds' && mx === r && r !== mn) amt = mx - md;
        else if (range === 'greens' && mx === g && g !== mn) amt = mx - md;
        else if (range === 'blues' && mx === b && b !== mn) amt = mx - md;
        else if (range === 'yellows' && mn === b) amt = md - mn;
        else if (range === 'cyans' && mn === r) amt = md - mn;
        else if (range === 'magentas' && mn === g) amt = md - mn;
        else if (range === 'whites') amt = Math.max(0, (mn - 128) * 2);
        else if (range === 'blacks') amt = Math.max(0, (128 - mx) * 2);
        else if (range === 'neutrals') amt = Math.max(0, 255 - (Math.abs(mx - 128) + Math.abs(mn - 128)));
        if (amt <= 0) return [r, g, b];
        const a = amt / 255;
        // голубой убирает красный, пурпурный — зелёный, жёлтый — синий; чёрный — все
        const adj = (v: number, k: number) => v - a * k * (rel ? v : 255) - a * K * (rel ? v : 255);
        return [adj(r, C), adj(g, M), adj(b, Y)];
      });
    },
  },
  {
    id: 'auto-tone',
    label: 'Автотон',
    group: 'auto',
    params: [],
    apply(img) {
      autoTone(img);
    },
  },
  {
    id: 'auto-contrast',
    label: 'Автоконтраст',
    group: 'auto',
    params: [],
    apply(img) {
      autoContrast(img);
    },
  },
  {
    id: 'auto-color',
    label: 'Автоцвет',
    group: 'auto',
    params: [],
    apply(img) {
      autoColor(img);
    },
  },
);
