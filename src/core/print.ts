import { createCanvas, ctx2d } from './canvas';

/**
 * Печать: раскладка картинки на листе (миллиметры), метки печати как в Photoshop
 * (углы и центры обреза, приводка, подпись), рендер листа в canvas нужного разрешения.
 */

export interface Paper {
  id: string;
  label: string;
  w: number;
  h: number;
}

export const PAPERS: Paper[] = [
  { id: 'a5', label: 'A5 (148 × 210 мм)', w: 148, h: 210 },
  { id: 'a4', label: 'A4 (210 × 297 мм)', w: 210, h: 297 },
  { id: 'a3', label: 'A3 (297 × 420 мм)', w: 297, h: 420 },
  { id: 'letter', label: 'Letter (8,5 × 11″)', w: 215.9, h: 279.4 },
  { id: 'legal', label: 'Legal (8,5 × 14″)', w: 215.9, h: 355.6 },
  { id: 'tabloid', label: 'Tabloid (11 × 17″)', w: 279.4, h: 431.8 },
  { id: 'photo', label: 'Фото 10 × 15 см', w: 101.6, h: 152.4 },
  { id: 'custom', label: 'Свой размер', w: 210, h: 297 },
];

export interface PrintMarks {
  corner: boolean;
  center: boolean;
  registration: boolean;
  description: boolean;
  border: boolean;
}

export interface PrintSettings {
  paper: string;
  customW: number;
  customH: number;
  landscape: boolean;
  /** Поля листа, мм. */
  margin: number;
  /** Положение левого верхнего угла картинки на листе, мм. */
  x: number;
  y: number;
  center: boolean;
  /** Ширина картинки на листе, мм (высота — по пропорции). */
  width: number;
  /** Разрешение картинки для «100%», пикс./дюйм. */
  ppi: number;
  /** Выпуск под обрез: метки отодвигаются от края картинки, мм. */
  bleed: number;
  marks: PrintMarks;
  /** Разрешение рендера листа, точек/дюйм. */
  dpi: number;
}

export const DEFAULT_PRINT: PrintSettings = {
  paper: 'a4',
  customW: 210,
  customH: 297,
  landscape: false,
  margin: 10,
  x: 10,
  y: 10,
  center: true,
  width: 100,
  ppi: 300,
  bleed: 0,
  marks: { corner: false, center: false, registration: false, description: false, border: false },
  dpi: 300,
};

export const MM_PER_INCH = 25.4;

/** Размер листа с учётом ориентации, мм. */
export function paperSize(s: PrintSettings) {
  const p = PAPERS.find((x) => x.id === s.paper) ?? PAPERS[1];
  const w = p.id === 'custom' ? s.customW : p.w, h = p.id === 'custom' ? s.customH : p.h;
  return s.landscape ? { w: Math.max(w, h), h: Math.min(w, h) } : { w: Math.min(w, h), h: Math.max(w, h) };
}

/** Прямоугольник картинки на листе (мм) — с учётом «по центру». */
export function imageRect(s: PrintSettings, imgW: number, imgH: number) {
  const P = paperSize(s);
  const w = s.width, h = (s.width * imgH) / Math.max(1, imgW);
  return s.center ? { x: (P.w - w) / 2, y: (P.h - h) / 2, w, h } : { x: s.x, y: s.y, w, h };
}

/** Ширина картинки, мм, для режимов подгонки. */
export function fitWidth(s: PrintSettings, imgW: number, imgH: number, mode: 'fit' | 'fill' | 'actual'): number {
  if (mode === 'actual') return (imgW / s.ppi) * MM_PER_INCH;
  const P = paperSize(s);
  const aw = Math.max(1, P.w - 2 * s.margin), ah = Math.max(1, P.h - 2 * s.margin);
  const k = mode === 'fit' ? Math.min(aw / imgW, ah / imgH) : Math.max(aw / imgW, ah / imgH);
  return imgW * k;
}

/** Фактическое разрешение картинки на листе, пикс./дюйм. */
export const effectivePpi = (s: PrintSettings, imgW: number) => (imgW / Math.max(0.01, s.width)) * MM_PER_INCH;

/**
 * Лист целиком: белая бумага, картинка, метки. k — пикселей на мм.
 * smallImg — уменьшенная копия для предпросмотра (качество рендера листа — по img).
 */
export function drawPrintPage(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, s: PrintSettings, k: number, info: { name: string; w: number; h: number }) {
  const P = paperSize(s);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, P.w * k, P.h * k);
  const r = imageRect(s, info.w, info.h);
  // картинка обрезается по листу, как при печати
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, P.w * k, P.h * k);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.x * k, r.y * k, r.w * k, r.h * k);
  ctx.restore();
  drawMarks(ctx, s, r, k, info);
}

function drawMarks(ctx: CanvasRenderingContext2D, s: PrintSettings, r: { x: number; y: number; w: number; h: number }, k: number, info: { name: string; w: number; h: number }) {
  const m = s.marks;
  const line = Math.max(0.6, 0.1 * k); // ~0,1 мм
  const gap = (2 + s.bleed) * k, len = 6 * k;
  const x0 = r.x * k, y0 = r.y * k, x1 = (r.x + r.w) * k, y1 = (r.y + r.h) * k;
  ctx.save();
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineWidth = line;
  ctx.beginPath();
  if (m.corner) {
    // углы обреза: короткие линии по продолжению краёв, с отступом от картинки
    for (const [x, y, sx, sy] of [[x0, y0, -1, -1], [x1, y0, 1, -1], [x0, y1, -1, 1], [x1, y1, 1, 1]] as const) {
      ctx.moveTo(x + sx * gap, y);
      ctx.lineTo(x + sx * (gap + len), y);
      ctx.moveTo(x, y + sy * gap);
      ctx.lineTo(x, y + sy * (gap + len));
    }
  }
  if (m.center) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    ctx.moveTo(cx, y0 - gap);
    ctx.lineTo(cx, y0 - gap - len);
    ctx.moveTo(cx, y1 + gap);
    ctx.lineTo(cx, y1 + gap + len);
    ctx.moveTo(x0 - gap, cy);
    ctx.lineTo(x0 - gap - len, cy);
    ctx.moveTo(x1 + gap, cy);
    ctx.lineTo(x1 + gap + len, cy);
  }
  ctx.stroke();
  if (m.registration) {
    // приводка: круг с перекрестьем посередине каждой стороны
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rad = 2.5 * k, off = gap + len + 4 * k;
    for (const [x, y] of [[cx, y0 - off], [cx, y1 + off], [x0 - off, cy], [x1 + off, cy]]) {
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.moveTo(x - rad * 1.6, y);
      ctx.lineTo(x + rad * 1.6, y);
      ctx.moveTo(x, y - rad * 1.6);
      ctx.lineTo(x, y + rad * 1.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, rad * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (m.border) ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  if (m.description) {
    ctx.font = `${Math.max(6, 2.6 * k)}px -apple-system, Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'top';
    const text = `${info.name} — ${info.w}×${info.h} px — ${r.w.toFixed(1)}×${r.h.toFixed(1)} мм — ${Math.round(effectivePpi(s, info.w))} ppi — ${new Date().toLocaleDateString()}`;
    ctx.fillText(text, x0, y1 + gap + len + (m.registration ? 10 : 2) * k);
  }
  ctx.restore();
}

/** Лист в canvas с разрешением dpi (для печати и PDF). */
export function renderPrintPage(img: HTMLCanvasElement, s: PrintSettings, name: string): HTMLCanvasElement {
  const P = paperSize(s);
  const k = s.dpi / MM_PER_INCH;
  const c = createCanvas(Math.round(P.w * k), Math.round(P.h * k));
  drawPrintPage(ctx2d(c), img, s, k, { name, w: img.width, h: img.height });
  return c;
}
