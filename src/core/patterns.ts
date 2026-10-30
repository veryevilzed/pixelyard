import { create } from 'zustand';
import { createCanvas, ctx2d, uid } from './canvas';

export interface PatternInfo {
  id: string;
  name: string;
  w: number;
  h: number;
  /** PNG data URL — для хранения в localStorage. */
  url: string;
  builtin?: boolean;
}

const STORAGE_KEY = 'pixelyard.patterns';

/** Готовые canvas узоров по id; заполняется при загрузке. */
const canvases = new Map<string, HTMLCanvasElement>();

function builtin(name: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): PatternInfo {
  const c = createCanvas(w, h);
  draw(ctx2d(c));
  const id = `builtin-${name}`;
  canvases.set(id, c);
  return { id, name, w, h, url: c.toDataURL('image/png'), builtin: true };
}

function makeBuiltins(): PatternInfo[] {
  return [
    builtin('Шахматка', 16, 16, (c) => {
      c.fillStyle = '#ccc';
      c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#888';
      c.fillRect(0, 0, 8, 8);
      c.fillRect(8, 8, 8, 8);
    }),
    builtin('Полосы', 16, 16, (c) => {
      c.fillStyle = '#ddd';
      c.fillRect(0, 0, 16, 16);
      c.strokeStyle = '#777';
      c.lineWidth = 4;
      c.beginPath();
      for (let k = -16; k <= 32; k += 8) {
        c.moveTo(k, 16);
        c.lineTo(k + 16, 0);
      }
      c.stroke();
    }),
    builtin('Точки', 12, 12, (c) => {
      c.fillStyle = '#eee';
      c.fillRect(0, 0, 12, 12);
      c.fillStyle = '#666';
      c.beginPath();
      c.arc(6, 6, 2.5, 0, Math.PI * 2);
      c.fill();
    }),
    builtin('Сетка', 16, 16, (c) => {
      c.fillStyle = '#f2f2f2';
      c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#9a9a9a';
      c.fillRect(0, 0, 16, 1);
      c.fillRect(0, 0, 1, 16);
    }),
    builtin('Кирпич', 32, 16, (c) => {
      c.fillStyle = '#b5543a';
      c.fillRect(0, 0, 32, 16);
      c.fillStyle = '#e8d8c8';
      c.fillRect(0, 7, 32, 2);
      c.fillRect(0, 15, 32, 1);
      c.fillRect(15, 0, 2, 7);
      c.fillRect(0, 9, 1, 6);
      c.fillRect(31, 9, 1, 6);
    }),
  ];
}

function loadSaved(): PatternInfo[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as PatternInfo[];
  } catch {
    return [];
  }
}

export const usePatterns = create<{ list: PatternInfo[]; loaded: number }>(() => ({
  list: [...makeBuiltins(), ...loadSaved()],
  loaded: 0,
}));

usePatterns.subscribe((s, p) => {
  if (s.list !== p.list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s.list.filter((x) => !x.builtin)));
    } catch {
      // переполнение localStorage — узор останется до перезапуска
    }
  }
});

function decode(p: PatternInfo) {
  if (canvases.has(p.id)) return;
  const img = new Image();
  img.onload = () => {
    const c = createCanvas(p.w, p.h);
    ctx2d(c).drawImage(img, 0, 0);
    canvases.set(p.id, c);
    // сообщаем подписчикам (рендеру), что узор готов
    usePatterns.setState((s) => ({ loaded: s.loaded + 1 }));
  };
  img.src = p.url;
}

for (const p of usePatterns.getState().list) decode(p);

export function patternCanvas(id: string | null | undefined): HTMLCanvasElement | null {
  if (!id) return null;
  return canvases.get(id) ?? null;
}

export function definePattern(source: HTMLCanvasElement, name: string): PatternInfo {
  const p: PatternInfo = { id: uid('pat'), name, w: source.width, h: source.height, url: source.toDataURL('image/png') };
  canvases.set(p.id, source);
  usePatterns.setState((s) => ({ list: [...s.list, p] }));
  return p;
}

export function deletePattern(id: string) {
  canvases.delete(id);
  usePatterns.setState((s) => ({ list: s.list.filter((p) => p.id !== id || p.builtin) }));
}

/** Canvas размером w×h, замощённый узором (с масштабом и смещением). */
export function tiled(id: string, w: number, h: number, scale = 1, offsetX = 0, offsetY = 0): HTMLCanvasElement | null {
  const pat = patternCanvas(id);
  if (!pat) return null;
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  const p = ctx.createPattern(pat, 'repeat');
  if (!p) return null;
  p.setTransform(new DOMMatrix().translate(offsetX, offsetY).scale(scale));
  ctx.fillStyle = p;
  ctx.fillRect(0, 0, w, h);
  return out;
}
