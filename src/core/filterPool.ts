import { FILTERS, type Params } from './filters';

/**
 * Фильтры в фоновых потоках. Попиксельные коррекции (каждый пиксель независимо) режутся на полосы
 * по числу ядер; автокоррекциям нужна вся картинка (гистограмма) — они целиком в одном потоке, чтобы
 * не замирал интерфейс. Размытие и всё, что на нём построено, остаётся в основном потоке: там оно
 * идёт фильтром холста на видеокарте.
 */

/** Каждый пиксель считается независимо от остальных — можно резать на полосы. */
const POINTWISE = new Set([
  'brightness-contrast', 'hue-saturation', 'levels', 'color-balance', 'exposure', 'invert', 'desaturate', 'posterize', 'threshold',
  'color-to-alpha', 'alpha-threshold', 'curves', 'vibrance', 'black-white', 'photo-filter', 'white-balance', 'color-balance-tones',
  'channel-mixer', 'gradient-map', 'selective-color',
]);
/** Нужна вся картинка, но без видеокарты — целиком в фоновом потоке. */
const WHOLE_IN_WORKER = new Set(['auto-enhance', 'auto-tone', 'auto-contrast', 'auto-color', 'pixelate']);

/** Меньше этого — быстрее в основном потоке (пересылка дороже). */
const MIN_PIXELS = 256 * 256;

interface Pending {
  resolve: (r: { buf: ArrayBuffer; w: number; h: number }) => void;
  reject: (e: Error) => void;
}

let workers: Worker[] | null = null;
let broken = false;
const pending = new Map<number, Pending>();
let nextId = 1;
let rr = 0;

function pool(): Worker[] | null {
  if (broken) return null;
  if (workers) return workers;
  try {
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./filterWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const { id, buf, w: width, h, error } = e.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (error) p.reject(new Error(error));
        else p.resolve({ buf, w: width, h });
      };
      w.onerror = () => {
        // поток не поднялся (нет поддержки) — дальше всё в основном потоке
        broken = true;
        for (const [, p] of pending) p.reject(new Error('worker'));
        pending.clear();
      };
      return w;
    });
    return workers;
  } catch {
    broken = true;
    return null;
  }
}

function post(w: Worker, filterId: string, params: Params, data: Uint8ClampedArray, width: number, height: number) {
  return new Promise<{ buf: ArrayBuffer; w: number; h: number }>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const buf = data.buffer as ArrayBuffer;
    w.postMessage({ id, filterId, params, buf, w: width, h: height }, [buf]);
  });
}

/** Применить фильтр к картинке; пиксели img могут быть отданы потокам (не используйте img после вызова). */
export async function applyFilterAsync(img: ImageData, filterId: string, params: Params): Promise<ImageData> {
  const f = FILTERS.find((x) => x.id === filterId)!;
  const ws = img.width * img.height >= MIN_PIXELS ? pool() : null;
  const main = () => f.apply(img, params) ?? img;
  if (!ws || (!POINTWISE.has(filterId) && !WHOLE_IN_WORKER.has(filterId))) return main();
  try {
    if (WHOLE_IN_WORKER.has(filterId)) {
      const r = await post(ws[rr++ % ws.length], filterId, params, img.data.slice(), img.width, img.height);
      return new ImageData(new Uint8ClampedArray(r.buf), r.w, r.h);
    }
    // полосы по числу потоков
    const { width: w, height: h } = img;
    const rows = Math.ceil(h / ws.length);
    const parts = await Promise.all(
      ws.map((wk, i) => {
        const y0 = i * rows, y1 = Math.min(h, y0 + rows);
        if (y1 <= y0) return null;
        return post(wk, filterId, params, img.data.slice(y0 * w * 4, y1 * w * 4), w, y1 - y0).then((r) => ({ y0, r }));
      }),
    );
    const out = new ImageData(w, h);
    for (const p of parts) if (p) out.data.set(new Uint8ClampedArray(p.r.buf), p.y0 * w * 4);
    return out;
  } catch {
    // поток упал — считаем здесь
    return main();
  }
}
