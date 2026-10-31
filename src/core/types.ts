export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'lighter';

export const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: 'normal', label: 'Обычный' },
  { id: 'multiply', label: 'Умножение' },
  { id: 'screen', label: 'Экран' },
  { id: 'overlay', label: 'Перекрытие' },
  { id: 'darken', label: 'Затемнение' },
  { id: 'lighten', label: 'Замена светлым' },
  { id: 'color-dodge', label: 'Осветление основы' },
  { id: 'color-burn', label: 'Затемнение основы' },
  { id: 'hard-light', label: 'Жёсткий свет' },
  { id: 'soft-light', label: 'Мягкий свет' },
  { id: 'difference', label: 'Разница' },
  { id: 'exclusion', label: 'Исключение' },
  { id: 'hue', label: 'Цветовой тон' },
  { id: 'saturation', label: 'Насыщенность' },
  { id: 'color', label: 'Цветность' },
  { id: 'luminosity', label: 'Яркость' },
  { id: 'lighter', label: 'Линейный осветлитель (добавить)' },
];

/**
 * Слой неизменяем на уровне свойств: изменение имени/прозрачности создаёт
 * новый объект с тем же canvas, чтобы снимки истории оставались корректными.
 * Пиксели canvas меняются только через Doc.pixelEdit (с записью в историю).
 * Canvas всегда размером с документ.
 */
export interface Layer {
  id: string;
  name: string;
  canvas: HTMLCanvasElement;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  /** Непрозрачность заливки: гасит пиксели слоя, но не его эффекты. */
  fillOpacity: number; // 0..1
  blend: BlendMode;
  /** Обтравочная маска: слой виден только там, где есть пиксели нижнего не-обтравочного слоя. */
  clip: boolean;
  /** Маска слоя (альфа = видимость) или null. Неизменяемая ссылка — правится через pixelEdit. */
  mask: HTMLCanvasElement | null;
  maskEnabled: boolean;
  effects: LayerEffects;
  /** Цветовая метка в панели слоёв (только для наглядности). */
  color?: LabelColor | null;
  /** Папка (id из Doc.groups); слои одной папки идут в списке подряд. */
  group?: string | null;
  /** Текстовый слой: пиксели строятся из этих данных; null — обычный (растровый) слой. */
  text?: TextData | null;
}

/** justify — по ширине: строки текста в рамке растягиваются до краёв (кроме последней строки абзаца). */
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type TextVAlign = 'top' | 'middle' | 'bottom';

export interface TextData {
  value: string;
  /**
   * Точечный текст — точка привязки первой строки (верх; слева / по центру / справа — по align).
   * Текст в рамке — левый верхний угол рамки.
   */
  x: number;
  y: number;
  /** Рамка текста (как «абзацный текст» Photoshop): строки переносятся по ширине; нет — точечный текст. */
  box?: { w: number; h: number } | null;
  align?: TextAlign;
  /** Выравнивание по высоте внутри рамки. */
  valign?: TextVAlign;
  /** CSS-семейство или «bmfont:<id>» — растровый шрифт из библиотеки. */
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  antialias: boolean;
  color: RGBA;
  /** Растровый шрифт: перекрасить глифы в color. */
  bmTint: boolean;
}

export type LabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray';

export const LABEL_COLORS: { id: LabelColor; label: string; css: string }[] = [
  { id: 'red', label: 'Красный', css: '#e5484d' },
  { id: 'orange', label: 'Оранжевый', css: '#f76b15' },
  { id: 'yellow', label: 'Жёлтый', css: '#ffc53d' },
  { id: 'green', label: 'Зелёный', css: '#30a46c' },
  { id: 'blue', label: 'Синий', css: '#3e63dd' },
  { id: 'violet', label: 'Фиолетовый', css: '#8e4ec6' },
  { id: 'gray', label: 'Серый', css: '#8b8d98' },
];

export const labelCss = (c: LabelColor | null | undefined) => (c ? LABEL_COLORS.find((x) => x.id === c)?.css ?? null : null);

/** Папка слоёв: скрытие и непрозрачность действуют на все её слои. */
export interface LayerGroup {
  id: string;
  name: string;
  visible: boolean;
  collapsed: boolean;
  opacity: number;
  color: LabelColor | null;
}

export interface ShadowFx {
  enabled: boolean;
  color: RGBA;
  opacity: number; // 0..100
  angle: number; // градусы, направление «света» как в Photoshop
  distance: number;
  size: number;
  spread: number; // 0..100
}

export interface GlowFx {
  enabled: boolean;
  color: RGBA;
  opacity: number;
  size: number;
  spread: number;
}

export interface StrokeFx {
  enabled: boolean;
  color: RGBA;
  opacity: number;
  size: number;
  position: 'outside' | 'inside' | 'center';
}

export interface ColorOverlayFx {
  enabled: boolean;
  color: RGBA;
  opacity: number;
  blend: BlendMode;
}

export interface GradientOverlayFx {
  enabled: boolean;
  from: RGBA;
  to: RGBA;
  opacity: number;
  angle: number;
  kind: 'linear' | 'radial';
  reverse: boolean;
  scale: number; // %
  blend: BlendMode;
}

export interface PatternOverlayFx {
  enabled: boolean;
  patternId: string | null;
  scale: number; // %
  opacity: number;
  blend: BlendMode;
}

export interface LayerEffects {
  dropShadow: ShadowFx;
  outerGlow: GlowFx;
  innerShadow: ShadowFx;
  innerGlow: GlowFx;
  colorOverlay: ColorOverlayFx;
  gradientOverlay: GradientOverlayFx;
  patternOverlay: PatternOverlayFx;
  stroke: StrokeFx;
}

export const DEFAULT_EFFECTS: LayerEffects = {
  dropShadow: { enabled: false, color: [0, 0, 0, 255], opacity: 75, angle: 120, distance: 5, size: 5, spread: 0 },
  outerGlow: { enabled: false, color: [255, 255, 190, 255], opacity: 75, size: 8, spread: 0 },
  innerShadow: { enabled: false, color: [0, 0, 0, 255], opacity: 75, angle: 120, distance: 5, size: 5, spread: 0 },
  innerGlow: { enabled: false, color: [255, 255, 190, 255], opacity: 75, size: 8, spread: 0 },
  colorOverlay: { enabled: false, color: [255, 0, 0, 255], opacity: 100, blend: 'normal' },
  gradientOverlay: { enabled: false, from: [0, 0, 0, 255], to: [255, 255, 255, 255], opacity: 100, angle: 90, kind: 'linear', reverse: false, scale: 100, blend: 'normal' },
  patternOverlay: { enabled: false, patternId: 'builtin-Шахматка', scale: 100, opacity: 100, blend: 'normal' },
  stroke: { enabled: false, color: [0, 0, 0, 255], opacity: 100, size: 3, position: 'outside' },
};

export function hasEffects(e: LayerEffects) {
  return Object.values(e).some((x) => x.enabled);
}

export interface NineSlice {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Slice {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nine: NineSlice | null;
}

export interface Selection {
  /** Маска размером с документ, выделение = альфа-канал. */
  mask: HTMLCanvasElement;
  bounds: Rect;
  /** Контур для «бегущих муравьёв» в координатах документа. */
  outline: Path2D;
}

/** Линии раскроя инструмента «Нож» (координаты в пикселях документа). */
/** Направляющие — те же вертикальные (x) и горизонтальные (y) линии. */
export interface Cuts {
  x: number[];
  y: number[];
}

export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

export type RGBA = [number, number, number, number];
