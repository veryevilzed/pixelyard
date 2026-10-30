import * as A from './actions';
import * as P from './panes';
import { FILTERS } from './core/filters';
import { activeDoc, app, openDialog, setOpts, setPrefs, useApp, type ToolId } from './store';
import { changed } from './tools/base';

export interface MenuItem {
  label: string;
  shortcut?: string;
  action: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
}
export type MenuEntry = MenuItem | 'sep' | { label: string; submenu: MenuEntry[] };
export interface Menu {
  label: string;
  items: MenuEntry[];
}

const hasDoc = () => !!activeDoc();
const ADJUST_KEYS: Record<string, string> = {
  levels: 'Mod+L',
  curves: 'Mod+M',
  'hue-saturation': 'Mod+U',
  invert: 'Mod+I',
  desaturate: 'Shift+Mod+U',
  'brightness-contrast': 'Alt+Mod+B',
  'black-white': 'Alt+Shift+Mod+B',
  'color-balance-tones': 'Mod+B',
  'auto-tone': 'Shift+Mod+L',
  'auto-contrast': 'Alt+Shift+Mod+L',
  'auto-color': 'Shift+Mod+B',
};
const hasSel = () => !!activeDoc()?.selection;
const hasLayer = () => !!activeDoc()?.activeLayer;
const multiLayers = () => (activeDoc()?.layers.length ?? 0) > 1;
const canSplit = () => {
  const s = useApp.getState();
  return s.panes.length === 1 && (s.panes[0]?.docIds.length ?? 0) > 1;
};
const hasMask = () => !!activeDoc()?.activeLayer?.mask;
const hasCuts = () => { const d = activeDoc(); return !!d && d.cuts.x.length + d.cuts.y.length > 0; };
const hasSlices = () => (activeDoc()?.slices.length ?? 0) > 0;
const pref = (k: 'pixelGrid' | 'grid' | 'snap' | 'slices' | 'sliceLabels' | 'rulers' | 'guides' | 'lockGuides' | 'clampPan') => ({
  action: () => setPrefs({ [k]: !app().prefs[k] }),
  checked: () => app().prefs[k],
});

export const MENUS: Menu[] = [
  {
    label: 'Файл',
    items: [
      { label: 'Новый…', shortcut: 'Mod+N', action: () => openDialog({ kind: 'new' }) },
      { label: 'Открыть…', shortcut: 'Mod+O', action: () => void A.openDocuments() },
      { label: 'Поместить как слой…', shortcut: 'Shift+Mod+O', action: () => void A.placeFiles(), enabled: hasDoc },
      'sep',
      { label: 'Сохранить', shortcut: 'Mod+S', action: () => void A.saveDoc(false), enabled: hasDoc },
      { label: 'Сохранить как…', shortcut: 'Shift+Mod+S', action: () => void A.saveDoc(true), enabled: hasDoc },
      'sep',
      { label: 'Экспорт…', shortcut: 'Shift+Mod+E', action: () => openDialog({ kind: 'export' }), enabled: hasDoc },
      { label: 'Экспорт слоёв по отдельности…', action: () => openDialog({ kind: 'export', source: 'layers' }), enabled: hasDoc },
      { label: 'Экспорт слайсов…', action: () => openDialog({ kind: 'export', source: 'slices' }), enabled: hasSlices },
      { label: 'Быстрый экспорт в PNG', shortcut: 'Alt+Shift+Mod+E', action: () => void A.quickExportPng(), enabled: hasDoc },
      'sep',
      { label: 'Закрыть', shortcut: 'Mod+W', action: () => { const d = activeDoc(); if (d) void A.closeDoc(d.id); }, enabled: hasDoc },
    ],
  },
  {
    label: 'Правка',
    items: [
      { label: 'Отменить', shortcut: 'Mod+Z', action: A.undo, enabled: () => !!activeDoc()?.undoStack.length },
      { label: 'Повторить', shortcut: 'Shift+Mod+Z', action: A.redo, enabled: () => !!activeDoc()?.redoStack.length },
      'sep',
      { label: 'Вырезать', shortcut: 'Mod+X', action: A.cut, enabled: hasLayer },
      { label: 'Копировать', shortcut: 'Mod+C', action: () => A.copy(false), enabled: hasLayer },
      { label: 'Копировать сведённое', shortcut: 'Shift+Mod+C', action: () => A.copy(true), enabled: hasDoc },
      { label: 'Вставить', shortcut: 'Mod+V', action: () => void A.paste() },
      { label: 'Вставить как новый документ', shortcut: 'Alt+Mod+V', action: A.pasteAsNewDoc },
      { label: 'Очистить', shortcut: 'Backspace', action: () => A.clearSelectionPixels(), enabled: hasLayer },
      'sep',
      { label: 'Залить основным цветом', shortcut: 'Alt+Backspace', action: () => A.fillSelection('fg'), enabled: hasLayer },
      { label: 'Залить фоновым цветом', shortcut: 'Mod+Backspace', action: () => A.fillSelection('bg'), enabled: hasLayer },
      { label: 'Выполнить заливку (цвет, узор)…', shortcut: 'Shift+F5', action: () => openDialog({ kind: 'fill' }), enabled: hasLayer },
      { label: 'Обводка выделения 1px', action: () => A.strokeSelection(1), enabled: hasSel },
      { label: 'Определить узор', action: A.definePatternAction, enabled: hasDoc },
      'sep',
      { label: 'Свободная трансформация', shortcut: 'Mod+T', action: () => A.freeTransform('free'), enabled: hasLayer },
      {
        label: 'Трансформирование',
        submenu: [
          { label: 'Масштаб и поворот', action: () => A.freeTransform('free'), enabled: hasLayer },
          { label: 'Наклон', action: () => A.freeTransform('skew'), enabled: hasLayer },
          { label: 'Искажение', action: () => A.freeTransform('distort'), enabled: hasLayer },
          { label: 'Перспектива', action: () => A.freeTransform('perspective'), enabled: hasLayer },
        ],
      },
      { label: 'Отразить слой по горизонтали', action: () => A.flipLayer('h'), enabled: hasLayer },
      { label: 'Отразить слой по вертикали', action: () => A.flipLayer('v'), enabled: hasLayer },
      'sep',
      { label: 'Горячие клавиши', shortcut: 'Mod+/', action: () => openDialog({ kind: 'shortcuts' }) },
    ],
  },
  {
    label: 'Изображение',
    items: [
      {
        label: 'Коррекция',
        submenu: FILTERS.filter((f) => f.group === 'adjust').map((f) => ({
          label: f.label,
          action: () => A.runFilter(f.id),
          enabled: hasLayer,
          shortcut: ADJUST_KEYS[f.id],
        })),
      },
      ...FILTERS.filter((f) => f.group === 'auto').map((f) => ({ label: f.label, action: () => A.runFilter(f.id), enabled: hasLayer, shortcut: ADJUST_KEYS[f.id] })),
      'sep',
      { label: 'Размер изображения…', shortcut: 'Alt+Mod+I', action: () => openDialog({ kind: 'image-size' }), enabled: hasDoc },
      { label: 'Размер холста…', shortcut: 'Alt+Mod+C', action: () => openDialog({ kind: 'canvas-size' }), enabled: hasDoc },
      'sep',
      { label: 'Повернуть на 90° по часовой', action: () => A.rotateCanvas(90), enabled: hasDoc },
      { label: 'Повернуть на 90° против часовой', action: () => A.rotateCanvas(-90), enabled: hasDoc },
      { label: 'Повернуть на 180°', action: () => A.rotateCanvas(180), enabled: hasDoc },
      { label: 'Отразить холст по горизонтали', action: () => A.flipCanvas('h'), enabled: hasDoc },
      { label: 'Отразить холст по вертикали', action: () => A.flipCanvas('v'), enabled: hasDoc },
      'sep',
      { label: 'Кадрировать по выделению', action: A.cropToSelection, enabled: hasSel },
      { label: 'Тримминг (обрезать прозрачное)', action: A.trimTransparent, enabled: hasDoc },
    ],
  },
  {
    label: 'Слои',
    items: [
      { label: 'Новый слой', shortcut: 'Shift+Mod+N', action: A.newLayer, enabled: hasDoc },
      { label: 'Дублировать слой', action: A.duplicateLayer, enabled: hasLayer },
      { label: 'Удалить слой', action: A.deleteLayer, enabled: multiLayers },
      'sep',
      { label: 'Новый слой из выделенного', shortcut: 'Mod+J', action: () => A.layerVia(false), enabled: hasLayer },
      { label: 'Вырезать на новый слой', shortcut: 'Shift+Mod+J', action: () => A.layerVia(true), enabled: hasLayer },
      'sep',
      { label: 'Поднять слой', shortcut: 'Mod+]', action: () => A.moveLayerBy(1), enabled: multiLayers },
      { label: 'Опустить слой', shortcut: 'Mod+[', action: () => A.moveLayerBy(-1), enabled: multiLayers },
      'sep',
      { label: 'Стиль слоя (тень, обводка, наложение)…', action: () => openDialog({ kind: 'layer-style' }), enabled: hasLayer },
      {
        label: 'Стиль слоя',
        submenu: [
          { label: 'Скопировать стиль', action: A.copyStyle, enabled: hasLayer },
          { label: 'Вставить стиль', action: A.pasteStyle, enabled: hasLayer },
          { label: 'Очистить стиль', action: A.clearStyle, enabled: hasLayer },
          'sep',
          { label: 'Растрировать стиль (запечь в пиксели)', action: A.rasterizeStyle, enabled: hasLayer },
        ],
      },
      {
        label: 'Маска слоя',
        submenu: [
          { label: 'Показать всё', action: () => A.addMask('reveal'), enabled: () => !!activeDoc()?.activeLayer && !activeDoc()?.activeLayer?.mask },
          { label: 'Скрыть всё', action: () => A.addMask('hide'), enabled: () => !!activeDoc()?.activeLayer && !activeDoc()?.activeLayer?.mask },
          { label: 'Из выделения', action: () => A.addMask('selection'), enabled: () => hasSel() && !activeDoc()?.activeLayer?.mask },
          'sep',
          { label: 'Редактировать маску', shortcut: 'Mod+\\', action: () => A.setEditMask(!activeDoc()?.editMask), checked: () => !!activeDoc()?.editingMask, enabled: hasMask },
          { label: 'Включить/отключить маску', action: A.toggleMaskEnabled, enabled: hasMask },
          { label: 'Применить маску', action: A.applyMask, enabled: hasMask },
          { label: 'Удалить маску', action: A.deleteMask, enabled: hasMask },
        ],
      },
      { label: 'Обтравочная маска', shortcut: 'Alt+Mod+G', action: A.toggleClip, enabled: hasLayer, checked: () => !!activeDoc()?.activeLayer?.clip },
      'sep',
      { label: 'Объединить с нижним', shortcut: 'Mod+E', action: A.mergeDown, enabled: multiLayers },
      { label: 'Объединить видимые', action: A.mergeVisible, enabled: multiLayers },
      { label: 'Выполнить сведение', action: A.flatten, enabled: multiLayers },
      'sep',
      {
        label: 'Выровнять',
        submenu: [
          { label: 'По левому краю', action: () => A.alignLayer('left'), enabled: hasLayer },
          { label: 'По центру по горизонтали', action: () => A.alignLayer('hcenter'), enabled: hasLayer },
          { label: 'По правому краю', action: () => A.alignLayer('right'), enabled: hasLayer },
          'sep',
          { label: 'По верхнему краю', action: () => A.alignLayer('top'), enabled: hasLayer },
          { label: 'По центру по вертикали', action: () => A.alignLayer('vcenter'), enabled: hasLayer },
          { label: 'По нижнему краю', action: () => A.alignLayer('bottom'), enabled: hasLayer },
        ],
      },
    ],
  },
  {
    label: 'Выделение',
    items: [
      { label: 'Всё', shortcut: 'Mod+A', action: A.selectAllAction, enabled: hasDoc },
      { label: 'Снять выделение', shortcut: 'Mod+D', action: A.deselect, enabled: hasSel },
      { label: 'Инверсия', shortcut: 'Shift+Mod+I', action: A.invertSel, enabled: hasSel },
      { label: 'Непрозрачные пиксели слоя', action: A.selectLayerAlpha, enabled: hasLayer },
      { label: 'Цветовой диапазон (по цвету)…', shortcut: 'Alt+Mod+O', action: () => openDialog({ kind: 'color-range' }), enabled: hasDoc },
      'sep',
      { label: 'Выделенное в новый документ', shortcut: 'Alt+Mod+N', action: () => A.selectionToNewDoc(false), enabled: hasSel },
      { label: 'Выделенное (все слои) в новый документ', shortcut: 'Alt+Shift+Mod+N', action: () => A.selectionToNewDoc(true), enabled: hasSel },
      { label: 'Кадрировать по выделению', shortcut: 'Alt+Mod+X', action: A.cropToSelection, enabled: hasSel },
      'sep',
      { label: 'Расширить…', action: () => openDialog({ kind: 'select-modify', op: 'grow' }), enabled: hasSel },
      { label: 'Сжать…', action: () => openDialog({ kind: 'select-modify', op: 'shrink' }), enabled: hasSel },
      { label: 'Граница…', action: () => openDialog({ kind: 'select-modify', op: 'border' }), enabled: hasSel },
      { label: 'Растушевка…', shortcut: 'Shift+F6', action: () => openDialog({ kind: 'select-modify', op: 'feather' }), enabled: hasSel },
    ],
  },
  {
    label: 'Фильтр',
    items: FILTERS.filter((f) => f.group === 'filter').map((f) => ({ label: f.label, action: () => A.runFilter(f.id), enabled: hasLayer })),
  },
  {
    label: 'Нарезка',
    items: [
      { label: 'Нарезать сеткой…', action: () => openDialog({ kind: 'grid-slice' }), enabled: hasDoc },
      { label: 'Авто-нарезка по прозрачности…', action: () => openDialog({ kind: 'auto-slice' }), enabled: hasDoc },
      'sep',
      { label: 'Нож: резы с шагом…', action: () => openDialog({ kind: 'cut-step' }), enabled: hasDoc },
      { label: 'Нож: резы по направляющим', action: A.guidesToCuts, enabled: hasDoc },
      { label: 'Нож: куски в слайсы', action: A.cutsToSlices, enabled: hasCuts },
      { label: 'Нож: куски в слои', action: A.cutsToLayers, enabled: hasCuts },
      { label: 'Нож: экспорт кусков в файлы…', action: A.exportPieces, enabled: hasCuts },
      { label: 'Нож: очистить резы', action: A.clearCuts, enabled: hasCuts },
      'sep',
      { label: 'Слайс из выделения', action: A.sliceFromSelection, enabled: hasSel },
      { label: 'Слайсы по слоям', action: A.slicesFromLayers, enabled: hasDoc },
      { label: 'Выделить область слайса', action: A.selectSliceArea, enabled: () => !!activeDoc()?.activeSliceId },
      { label: 'Слайсы → слои', action: A.slicesToLayers, enabled: hasSlices },
      'sep',
      { label: 'Удалить все слайсы', action: A.clearSlices, enabled: hasSlices },
      { label: 'Экспорт слайсов…', action: () => openDialog({ kind: 'export', source: 'slices' }), enabled: hasSlices },
    ],
  },
  {
    label: 'Просмотр',
    items: [
      { label: 'Увеличить', shortcut: 'Mod+=', action: () => A.zoomBy(1), enabled: hasDoc },
      { label: 'Уменьшить', shortcut: 'Mod+-', action: () => A.zoomBy(-1), enabled: hasDoc },
      { label: 'Вписать в экран', shortcut: 'Mod+0', action: A.fitToScreen, enabled: hasDoc },
      { label: 'Заполнить экран', action: () => A.fitMode('fill'), enabled: hasDoc },
      { label: 'Вписать по ширине', action: () => A.fitMode('width'), enabled: hasDoc },
      { label: 'Вписать по высоте', action: () => A.fitMode('height'), enabled: hasDoc },
      { label: 'Центрировать', shortcut: 'Shift+Mod+0', action: A.centerView, enabled: hasDoc },
      { label: 'Реальный размер (100%)', shortcut: 'Mod+1', action: () => A.zoomTo(1), enabled: hasDoc },
      { label: '200%', shortcut: 'Mod+2', action: () => A.zoomTo(2), enabled: hasDoc },
      { label: '800%', shortcut: 'Mod+8', action: () => A.zoomTo(8), enabled: hasDoc },
      'sep',
      { label: 'Ограничивать прокрутку краем картинки', ...pref('clampPan') },
      'sep',
      { label: 'Линейки', shortcut: 'Mod+R', ...pref('rulers') },
      { label: 'Направляющие', shortcut: 'Mod+;', ...pref('guides') },
      { label: 'Закрепить направляющие', shortcut: 'Alt+Mod+;', ...pref('lockGuides') },
      { label: 'Новая направляющая…', action: () => openDialog({ kind: 'new-guide' }), enabled: hasDoc },
      { label: 'Направляющие по выделению / слайсу', action: A.guidesFromSelection, enabled: hasDoc },
      { label: 'Удалить направляющие', action: A.clearGuides, enabled: hasDoc },
      'sep',
      { label: 'Пиксельная сетка (≥800%)', ...pref('pixelGrid') },
      { label: 'Сетка', shortcut: "Mod+'", ...pref('grid') },
      { label: 'Настройки сетки…', action: () => openDialog({ kind: 'grid-settings' }) },
      { label: 'Привязка (сетка, направляющие, края)', shortcut: 'Shift+Mod+;', ...pref('snap') },
      'sep',
      { label: 'Показывать слайсы', ...pref('slices') },
      { label: 'Подписи слайсов', ...pref('sliceLabels') },
      {
        label: 'Светлая шахматка',
        action: () => {
          setPrefs({ checker: app().prefs.checker === 'dark' ? 'light' : 'dark' });
          changed();
        },
        checked: () => app().prefs.checker === 'light',
      },
    ],
  },
  {
    label: 'Окно',
    items: [
      { label: 'Разделить: активный документ вправо', action: () => P.splitActive('h'), enabled: canSplit },
      { label: 'Разделить: активный документ вниз', action: () => P.splitActive('v'), enabled: canSplit },
      { label: 'Объединить области', action: P.mergePanes, enabled: () => useApp.getState().panes.length > 1 },
      {
        label: 'Расположить области рядом / друг под другом',
        action: () => useApp.setState((s) => ({ split: s.split === 'h' ? 'v' : 'h' })),
        enabled: () => useApp.getState().panes.length > 1,
      },
      'sep',
      { label: 'Следующая вкладка', shortcut: 'Ctrl+Tab', action: () => P.cycleTab(1), enabled: hasDoc },
      { label: 'Предыдущая вкладка', shortcut: 'Shift+Ctrl+Tab', action: () => P.cycleTab(-1), enabled: hasDoc },
      'sep',
      ...(['navigator', 'color', 'layers', 'slices', 'history'] as const).map((k) => ({
        label: { navigator: 'Навигатор', color: 'Цвет', layers: 'Слои', slices: 'Слайсы', history: 'История' }[k],
        action: () => useApp.setState((s) => ({ panels: { ...s.panels, [k]: !s.panels[k] } })),
        checked: () => useApp.getState().panels[k],
      })),
    ],
  },
  {
    label: 'Справка',
    items: [
      { label: 'Горячие клавиши', action: () => openDialog({ kind: 'shortcuts' }) },
      { label: 'О программе', action: () => openDialog({ kind: 'about' }) },
    ],
  },
];

export const TOOL_KEYS: Record<string, ToolId | ToolId[]> = {
  v: 'move',
  m: ['marquee-rect', 'marquee-ellipse'],
  l: ['lasso', 'polygon-lasso'],
  w: 'wand',
  c: 'crop',
  k: ['slice', 'knife'],
  i: 'eyedropper',
  b: 'brush',
  n: 'pencil',
  e: 'eraser',
  g: ['fill', 'gradient'],
  u: 'shape',
  t: 'text',
  h: 'hand',
  z: 'zoom',
};

const isMac = navigator.platform.toLowerCase().includes('mac') || navigator.userAgent.includes('Mac');

export function formatShortcut(s: string) {
  if (!isMac) return s.replace('Mod', 'Ctrl');
  return s
    .replace('Shift+', '⇧')
    .replace('Alt+', '⌥')
    .replace('Mod+', '⌘')
    .replace('Ctrl+', '⌃')
    .replace('Backspace', '⌫');
}

/** Нормализует событие клавиатуры в строку вида «Shift+Mod+Z». */
export function eventShortcut(e: KeyboardEvent): string {
  let key = e.key;
  // с Alt на macOS e.key содержит спецсимвол — берём физическую клавишу
  if (e.code.startsWith('Key')) key = e.code.slice(3);
  else if (e.code.startsWith('Digit')) key = e.code.slice(5);
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'Minus') key = '-';
  else if (e.code === 'BracketLeft') key = '[';
  else if (e.code === 'BracketRight') key = ']';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Quote') key = "'";
  else if (e.code === 'Semicolon') key = ';';
  else if (e.code === 'Backslash') key = '\\';
  else if (key === 'Delete') key = 'Backspace';
  if (key.length === 1) key = key.toUpperCase();
  const parts = [];
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  parts.push(key);
  return parts.join('+');
}

const MOD_ORDER = ['Shift', 'Alt', 'Mod'];
/** Канонический вид сочетания: модификаторы в фиксированном порядке, клавиша в верхнем регистре. */
function canon(s: string) {
  const parts = s.split('+');
  // клавиша «+» в сочетании вроде Mod++ не используется, поэтому split безопасен
  const key = parts.pop()!.toUpperCase();
  return [...parts.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b)), key].join('+');
}

export function findShortcut(sc: string, entries: MenuEntry[] = MENUS.flatMap((m) => m.items)): MenuItem | null {
  for (const e of entries) {
    if (e === 'sep') continue;
    if ('submenu' in e) {
      const r = findShortcut(sc, e.submenu);
      if (r) return r;
    } else if (e.shortcut && canon(e.shortcut) === canon(sc)) return e;
  }
  return null;
}

export function cycleTool(key: string) {
  const t = TOOL_KEYS[key];
  if (!t) return false;
  const cur = useApp.getState().tool;
  if (Array.isArray(t)) {
    const i = t.indexOf(cur);
    A.setTool(i >= 0 ? t[(i + 1) % t.length] : t[0]);
  } else A.setTool(t);
  return true;
}

export function adjustSize(dir: 1 | -1) {
  const { tool, opts } = app();
  const step = (v: number) => Math.max(1, Math.min(1000, v < 10 ? v + dir : Math.round(v * (dir > 0 ? 1.15 : 1 / 1.15))));
  if (tool === 'brush') setOpts({ brushSize: step(opts.brushSize) });
  else if (tool === 'pencil') setOpts({ pencilSize: Math.max(1, opts.pencilSize + dir) });
  else if (tool === 'eraser') setOpts({ eraserSize: opts.eraserMode === 'pencil' ? Math.max(1, opts.eraserSize + dir) : step(opts.eraserSize) });
  changed();
}
