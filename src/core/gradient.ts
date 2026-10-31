import type { Point, RGBA } from './types';

/**
 * Градиенты: точки цвета (с прозрачностью), наборы и отрисовка пяти видов, как в Photoshop.
 * Цвет точки — RGBA или 'fg'/'bg' (основной/фоновый — подставляются при рисовании).
 */

export type GradColor = RGBA | 'fg' | 'bg';
export interface GradStop {
  /** 0…1 */
  pos: number;
  color: GradColor;
  /** Непрозрачность точки 0…1 (для 'fg'/'bg' — отдельно от цвета). */
  alpha: number;
}
export interface GradientDef {
  id: string;
  name: string;
  stops: GradStop[];
}
export type GradientKind = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export const GRADIENT_KINDS: { id: GradientKind; label: string }[] = [
  { id: 'linear', label: 'Линейный' },
  { id: 'radial', label: 'Радиальный' },
  { id: 'angle', label: 'Угловой' },
  { id: 'reflected', label: 'Зеркальный' },
  { id: 'diamond', label: 'Ромбовидный' },
];

const s = (pos: number, color: GradColor, alpha = 1): GradStop => ({ pos, color, alpha });
const rgb = (hex: string): RGBA => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];

export const GRADIENT_PRESETS: GradientDef[] = [
  { id: 'fg-bg', name: 'Основной → фоновый', stops: [s(0, 'fg'), s(1, 'bg')] },
  { id: 'fg-clear', name: 'Основной → прозрачный', stops: [s(0, 'fg'), s(1, 'fg', 0)] },
  { id: 'bw', name: 'Чёрный → белый', stops: [s(0, rgb('#000000')), s(1, rgb('#ffffff'))] },
  { id: 'spectrum', name: 'Спектр', stops: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'].map((c, i, a) => s(i / (a.length - 1), rgb(c))) },
  { id: 'chrome', name: 'Хром', stops: [s(0, rgb('#29323c')), s(0.45, rgb('#d9dfe6')), s(0.5, rgb('#6b5f4f')), s(0.75, rgb('#c9b38e')), s(1, rgb('#fbf6ec'))] },
  { id: 'gold', name: 'Золото', stops: [s(0, rgb('#7a4f12')), s(0.35, rgb('#f6d27a')), s(0.6, rgb('#b8862b')), s(1, rgb('#fff1b8'))] },
  { id: 'sunset', name: 'Закат', stops: [s(0, rgb('#2b1055')), s(0.5, rgb('#d53369')), s(1, rgb('#ffcc70'))] },
  { id: 'sky', name: 'Небо', stops: [s(0, rgb('#0b3d91')), s(0.6, rgb('#5fa8ff')), s(1, rgb('#e6f4ff'))] },
  { id: 'mint', name: 'Мята', stops: [s(0, rgb('#0f9b8e')), s(1, rgb('#d4fc79'))] },
  { id: 'neon', name: 'Неон', stops: [s(0, rgb('#00f0ff')), s(0.5, rgb('#7a00ff')), s(1, rgb('#ff00c8'))] },
  { id: 'fire', name: 'Огонь', stops: [s(0, rgb('#1a0000')), s(0.35, rgb('#c41e00')), s(0.7, rgb('#ff9a00')), s(1, rgb('#fff3b0'))] },
  { id: 'shine', name: 'Блик', stops: [s(0, rgb('#ffffff'), 0), s(0.5, rgb('#ffffff'), 0.85), s(1, rgb('#ffffff'), 0)] },
];

/** Точки с подставленными цветами (по позиции), с учётом инверсии. */
export function resolveStops(stops: GradStop[], fg: RGBA, bg: RGBA, reverse = false): { pos: number; color: RGBA }[] {
  const list = stops
    .map((st) => {
      const c = st.color === 'fg' ? fg : st.color === 'bg' ? bg : st.color;
      return { pos: reverse ? 1 - st.pos : st.pos, color: [c[0], c[1], c[2], Math.round(255 * st.alpha * (c[3] / 255))] as RGBA };
    })
    .sort((a, b) => a.pos - b.pos);
  return list.length ? list : [{ pos: 0, color: fg }, { pos: 1, color: bg }];
}

/** Цвет градиента в точке t (0…1). */
export function sampleStops(st: { pos: number; color: RGBA }[], t: number): RGBA {
  if (t <= st[0].pos) return st[0].color;
  const last = st[st.length - 1];
  if (t >= last.pos) return last.color;
  for (let i = 1; i < st.length; i++) {
    if (t <= st[i].pos) {
      const a = st[i - 1], b = st[i];
      const k = (t - a.pos) / Math.max(1e-6, b.pos - a.pos);
      return [0, 1, 2, 3].map((j) => Math.round(a.color[j] + (b.color[j] - a.color[j]) * k)) as RGBA;
    }
  }
  return last.color;
}

const css = (c: RGBA) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(4)})`;

/** CSS для превью полоски градиента (под ним — шахматка). */
export function gradientCss(st: { pos: number; color: RGBA }[]) {
  return `linear-gradient(90deg, ${st.map((x) => `${css(x.color)} ${(x.pos * 100).toFixed(2)}%`).join(', ')})`;
}

/** Таблица на 1024 оттенка (для видов, которые считаются по пикселям). */
function lut(st: { pos: number; color: RGBA }[]) {
  const N = 1024;
  const t = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) t.set(sampleStops(st, i / (N - 1)), i * 4);
  return t;
}

/** Рисует градиент вида kind от a к b на весь холст (w×h). */
export function drawGradient(ctx: CanvasRenderingContext2D, w: number, h: number, a: Point, b: Point, kind: GradientKind, st: { pos: number; color: RGBA }[]) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const add = (g: CanvasGradient, map: (p: number) => number = (p) => p) => {
    for (const x of st) g.addColorStop(Math.min(1, Math.max(0, map(x.pos))), css(x.color));
    return g;
  };
  if (kind === 'linear') ctx.fillStyle = add(ctx.createLinearGradient(a.x, a.y, b.x, b.y));
  else if (kind === 'radial') ctx.fillStyle = add(ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, len));
  else if (kind === 'reflected') {
    // от зеркальной точки до конца: середина — начало градиента
    const g = ctx.createLinearGradient(a.x - dx, a.y - dy, b.x, b.y);
    for (const x of st) {
      g.addColorStop(0.5 - x.pos / 2, css(x.color));
      g.addColorStop(0.5 + x.pos / 2, css(x.color));
    }
    ctx.fillStyle = g;
  } else if (kind === 'angle' && typeof ctx.createConicGradient === 'function') {
    // по часовой стрелке от направления a→b
    ctx.fillStyle = add(ctx.createConicGradient(Math.atan2(dy, dx), a.x, a.y));
  } else {
    // ромб (и угловой без поддержки conic) — по пикселям через таблицу оттенков
    const table = lut(st);
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const ux = dx / len, uy = dy / len;
    const ang0 = Math.atan2(dy, dx);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5 - a.x, py = y + 0.5 - a.y;
        let t: number;
        if (kind === 'diamond') t = (Math.abs(px * ux + py * uy) + Math.abs(-px * uy + py * ux)) / len;
        else {
          let ang = Math.atan2(py, px) - ang0;
          ang = ((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          t = ang / (Math.PI * 2);
        }
        const k = Math.min(1023, Math.max(0, Math.round(t * 1023))) * 4;
        const i = (y * w + x) * 4;
        d[i] = table[k];
        d[i + 1] = table[k + 1];
        d[i + 2] = table[k + 2];
        d[i + 3] = table[k + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return;
  }
  ctx.fillRect(0, 0, w, h);
}

// ---------- свои наборы ----------

const USER_KEY = 'pixelyard.gradients';

export function loadUserGradients(): GradientDef[] {
  try {
    const v = JSON.parse(localStorage.getItem(USER_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((g) => g && Array.isArray(g.stops) && g.stops.length >= 2) : [];
  } catch {
    return [];
  }
}

export function saveUserGradients(list: GradientDef[]) {
  localStorage.setItem(USER_KEY, JSON.stringify(list));
}
