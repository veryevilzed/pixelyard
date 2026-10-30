import type { Doc, ViewState } from '../core/doc';
import type { ViewTransform } from '../core/render';
import type { Point } from '../core/types';
import { activeDoc, app, bump, toast } from '../store';

export interface PointerInfo {
  /** Координаты документа (дробные). */
  x: number;
  y: number;
  /** Координаты в CSS-пикселях относительно области просмотра. */
  sx: number;
  sy: number;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  ctrl: boolean;
  pressure: number;
  pointerType: string;
  button: number;
  detail: number;
}

export interface Tool {
  cursor?(p: PointerInfo | null, doc: Doc): string;
  down?(p: PointerInfo, doc: Doc): void;
  /** Движение с зажатой кнопкой. */
  drag?(p: PointerInfo, doc: Doc): void;
  /** Движение без кнопки. */
  hover?(p: PointerInfo, doc: Doc): void;
  up?(p: PointerInfo, doc: Doc): void;
  dblclick?(p: PointerInfo, doc: Doc): void;
  /** true — клавиша обработана. */
  key?(e: KeyboardEvent, doc: Doc): boolean;
  overlay?(ctx: CanvasRenderingContext2D, v: ViewTransform, doc: Doc): void;
  /** Вызывается при смене инструмента/документа: завершить или отменить незавершённое. */
  deactivate?(doc: Doc | null): void;
  /** Скрывать стандартное выделение (например, при перемещении выделенного). */
  hidesSelection?(): boolean;
}

// ---------- клик по холсту для диалогов ----------

/** Пока задан, клик по холсту отдаётся сюда, а не инструменту (пипетка в диалогах). */
let pickHook: ((x: number, y: number, p: PointerInfo) => void) | null = null;
export function setPickHook(fn: typeof pickHook) {
  pickHook = fn;
}
export function getPickHook() {
  return pickHook;
}

// ---------- шина перерисовки ----------

const renderCbs = new Set<() => void>();
/** Подписка на запросы перерисовки (области просмотра, навигатор). Возвращает отписку. */
export function onRenderRequest(cb: () => void) {
  renderCbs.add(cb);
  return () => renderCbs.delete(cb);
}
/** Перерисовать холст без изменения документа (оверлеи, превью). */
export function requestRender() {
  for (const cb of renderCbs) cb();
}
/** Документ изменился: обновить UI и холст. */
export function changed() {
  bump();
  requestRender();
}

// ---------- помощники ----------

export function pixel(p: Point): Point {
  return { x: Math.floor(p.x), y: Math.floor(p.y) };
}

/** Округляет до ближайшего узла пиксельной сетки, при включённой привязке — к пользовательской сетке. */
export function snapPoint(p: Point, view: ViewState): Point {
  const { prefs } = app();
  let x = Math.round(p.x), y = Math.round(p.y);
  if (!prefs.snap) return { x, y };
  const tol = 8 / view.zoom;
  let bx = tol, by = tol;
  const tryX = (v: number) => {
    const d = Math.abs(v - p.x);
    if (d <= bx) {
      bx = d;
      x = v;
    }
  };
  const tryY = (v: number) => {
    const d = Math.abs(v - p.y);
    if (d <= by) {
      by = d;
      y = v;
    }
  };
  if (prefs.grid && prefs.gridW > 0 && prefs.gridH > 0) {
    tryX(Math.round(p.x / prefs.gridW) * prefs.gridW);
    tryY(Math.round(p.y / prefs.gridH) * prefs.gridH);
  }
  // направляющие и края холста
  const doc = activeDoc();
  if (doc) {
    if (prefs.guides) {
      doc.guides.x.forEach(tryX);
      doc.guides.y.forEach(tryY);
    }
    [0, doc.width].forEach(tryX);
    [0, doc.height].forEach(tryY);
  }
  return { x, y };
}

/** Проверяет, можно ли рисовать на активном слое; сообщает причину, если нет. */
export function editableLayer(doc: Doc) {
  const l = doc.activeLayer;
  if (!l) {
    toast('Нет активного слоя', 'error');
    return null;
  }
  if (l.locked) {
    toast(`Слой «${l.name}» заблокирован`, 'error');
    return null;
  }
  if (!l.visible) {
    toast(`Слой «${l.name}» скрыт`, 'error');
    return null;
  }
  return l;
}

export function constrain45(a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

export function dashedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#000';
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  ctx.restore();
}

export function infoLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.save();
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(20,20,22,0.85)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, 18, 4);
  ctx.fill();
  ctx.fillStyle = '#eee';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 5, y + 9);
  ctx.restore();
}
