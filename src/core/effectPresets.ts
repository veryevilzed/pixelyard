import { FILTERS, defaultParams, type Params } from './filters';

/**
 * Готовые эффекты для «Браузера эффектов»: фильтр + параметры.
 * Параметры, зависящие от размера в пикселях (радиус, ячейка), на миниатюре масштабируются.
 */

export interface EffectPreset {
  id: string;
  label: string;
  category: EffectCategory;
  filterId: string;
  params?: Params;
}

export type EffectCategory = 'auto' | 'tone' | 'color' | 'bw' | 'style' | 'detail';

export const EFFECT_CATEGORIES: { id: EffectCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'auto', label: 'Авто' },
  { id: 'tone', label: 'Свет' },
  { id: 'color', label: 'Цвет' },
  { id: 'bw', label: 'Ч/Б' },
  { id: 'style', label: 'Стиль' },
  { id: 'detail', label: 'Детали' },
];

export const EFFECT_PRESETS: EffectPreset[] = [
  { id: 'enhance', label: 'Автоулучшение', category: 'auto', filterId: 'auto-enhance' },
  { id: 'enhance-strong', label: 'Улучшение+', category: 'auto', filterId: 'auto-enhance', params: { strength: 170 } },
  { id: 'auto-tone', label: 'Автотон', category: 'auto', filterId: 'auto-tone' },
  { id: 'auto-contrast', label: 'Автоконтраст', category: 'auto', filterId: 'auto-contrast' },
  { id: 'auto-color', label: 'Автоцвет', category: 'auto', filterId: 'auto-color' },

  { id: 'brighter', label: 'Светлее', category: 'tone', filterId: 'exposure', params: { exposure: 0.5 } },
  { id: 'darker', label: 'Темнее', category: 'tone', filterId: 'exposure', params: { exposure: -0.5 } },
  { id: 'contrast-up', label: 'Контрастнее', category: 'tone', filterId: 'brightness-contrast', params: { contrast: 35 } },
  { id: 'contrast-down', label: 'Мягче', category: 'tone', filterId: 'brightness-contrast', params: { contrast: -30 } },
  { id: 'shadows', label: 'Открыть тени', category: 'tone', filterId: 'shadows-highlights', params: { shadows: 45, highlights: 0 } },
  { id: 'highlights', label: 'Убрать пересвет', category: 'tone', filterId: 'shadows-highlights', params: { shadows: 0, highlights: 45 } },
  { id: 'fade', label: 'Выцветание', category: 'tone', filterId: 'levels', params: { outBlack: 40, outWhite: 235 } },

  { id: 'vivid', label: 'Сочнее', category: 'color', filterId: 'vibrance', params: { vibrance: 50 } },
  { id: 'muted', label: 'Приглушить', category: 'color', filterId: 'hue-saturation', params: { sat: -45 } },
  { id: 'warm', label: 'Теплее', category: 'color', filterId: 'white-balance', params: { temp: 35 } },
  { id: 'cool', label: 'Холоднее', category: 'color', filterId: 'white-balance', params: { temp: -35 } },
  { id: 'hue-left', label: 'Тон −40°', category: 'color', filterId: 'hue-saturation', params: { hue: -40 } },
  { id: 'hue-right', label: 'Тон +40°', category: 'color', filterId: 'hue-saturation', params: { hue: 40 } },
  { id: 'sunset', label: 'Закат', category: 'color', filterId: 'gradient-map', params: { from: [30, 10, 60, 255], mid: [220, 70, 70, 255], to: [255, 225, 150, 255] } },
  { id: 'teal-orange', label: 'Кино', category: 'color', filterId: 'color-balance-tones', params: { tone: 'shadows', r: -25, g: 0, b: 30 } },
  { id: 'invert', label: 'Негатив', category: 'color', filterId: 'invert' },

  { id: 'bw', label: 'Ч/Б', category: 'bw', filterId: 'black-white' },
  { id: 'bw-contrast', label: 'Ч/Б контраст', category: 'bw', filterId: 'black-white', params: { reds: 110, yellows: 120, greens: 20, cyans: 0, blues: -20, magentas: 60 } },
  { id: 'sepia', label: 'Сепия', category: 'bw', filterId: 'black-white', params: { tint: true, tintColor: [210, 170, 110, 255] } },
  { id: 'cyanotype', label: 'Цианотипия', category: 'bw', filterId: 'black-white', params: { tint: true, tintColor: [90, 150, 210, 255] } },
  { id: 'threshold', label: 'Порог', category: 'bw', filterId: 'threshold' },

  { id: 'posterize', label: 'Постер', category: 'style', filterId: 'posterize', params: { levels: 5 } },
  { id: 'pixelate', label: 'Пиксели', category: 'style', filterId: 'pixelate', params: { size: 8 } },
  { id: 'duotone', label: 'Дуотон', category: 'style', filterId: 'gradient-map', params: { from: [25, 20, 90, 255], to: [255, 120, 140, 255], useMid: false } },
  { id: 'outline', label: 'Обводка', category: 'style', filterId: 'outline' },
  { id: 'shadow', label: 'Тень', category: 'style', filterId: 'drop-shadow' },

  { id: 'sharpen', label: 'Резкость', category: 'detail', filterId: 'sharpen', params: { amount: 120, radius: 1 } },
  { id: 'sharpen-strong', label: 'Резкость+', category: 'detail', filterId: 'sharpen', params: { amount: 250, radius: 2 } },
  { id: 'blur', label: 'Размытие', category: 'detail', filterId: 'blur', params: { radius: 3 } },
  { id: 'blur-strong', label: 'Размытие+', category: 'detail', filterId: 'blur', params: { radius: 10 } },
];

/** Полные параметры пресета (значения по умолчанию + свои). */
export function presetParams(p: EffectPreset): Params {
  const f = FILTERS.find((x) => x.id === p.filterId)!;
  return { ...defaultParams(f), ...p.params };
}

/** Параметры для миниатюры: размеры в пикселях уменьшаются вместе с картинкой. */
export function thumbParams(p: EffectPreset, scale: number): Params {
  const out = presetParams(p);
  for (const k of ['radius', 'size', 'dx', 'dy', 'blur'] as const) {
    if (typeof out[k] === 'number') out[k] = Math.max(k === 'radius' || k === 'size' ? 1 : 0, Math.round((out[k] as number) * scale));
  }
  return out;
}
