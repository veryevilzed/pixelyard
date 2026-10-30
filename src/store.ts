import { create } from 'zustand';
import type { Doc } from './core/doc';
import type { RGBA } from './core/types';
import type { LoadedFile } from './core/platform';

export type ToolId =
  | 'move'
  | 'marquee-rect'
  | 'marquee-ellipse'
  | 'lasso'
  | 'polygon-lasso'
  | 'wand'
  | 'crop'
  | 'slice'
  | 'knife'
  | 'eyedropper'
  | 'brush'
  | 'pencil'
  | 'eraser'
  | 'fill'
  | 'gradient'
  | 'shape'
  | 'text'
  | 'hand'
  | 'zoom';

export interface ToolOptions {
  brushSize: number;
  brushHardness: number; // 0..100
  brushOpacity: number; // 0..100
  brushSpacing: number; // % от диаметра
  brushAntialias: boolean;
  pressure: boolean;
  pencilSize: number;
  pencilShape: 'square' | 'round';
  pixelPerfect: boolean;
  eraserSize: number;
  eraserMode: 'brush' | 'pencil';
  eraserHardness: number;
  eraserOpacity: number;
  fillTolerance: number;
  fillContiguous: boolean;
  fillSampleMerged: boolean;
  fillMode: 'color' | 'erase';
  fillSource: 'color' | 'pattern';
  fillPattern: string | null;
  wandTolerance: number;
  wandContiguous: boolean;
  wandSampleMerged: boolean;
  selectMode: 'replace' | 'add' | 'subtract' | 'intersect';
  selectAntialias: boolean;
  selectFixed: 'none' | 'ratio' | 'size';
  selectFixedW: number;
  selectFixedH: number;
  feather: number;
  shapeKind: 'rect' | 'ellipse' | 'line';
  shapeFill: boolean;
  shapeStroke: boolean;
  shapeStrokeWidth: number;
  shapeRadius: number;
  shapeNewLayer: boolean;
  shapeAntialias: boolean;
  gradientKind: 'linear' | 'radial';
  gradientToTransparent: boolean;
  gradientReverse: boolean;
  textFont: string;
  textSize: number;
  textBold: boolean;
  textItalic: boolean;
  textAntialias: boolean;
  moveAutoSelect: boolean;
  knifeDir: 'vertical' | 'horizontal';
  eyedropperMerged: boolean;
  cropDeletePixels: boolean;
}

export const DEFAULT_OPTIONS: ToolOptions = {
  brushSize: 24,
  brushHardness: 80,
  brushOpacity: 100,
  brushSpacing: 12,
  brushAntialias: true,
  pressure: true,
  pencilSize: 1,
  pencilShape: 'square',
  pixelPerfect: true,
  eraserSize: 24,
  eraserMode: 'brush',
  eraserHardness: 80,
  eraserOpacity: 100,
  fillTolerance: 32,
  fillContiguous: true,
  fillSampleMerged: false,
  fillMode: 'color',
  fillSource: 'color',
  fillPattern: 'builtin-Шахматка',
  wandTolerance: 32,
  wandContiguous: true,
  wandSampleMerged: false,
  selectMode: 'replace',
  selectAntialias: false,
  selectFixed: 'none',
  selectFixedW: 64,
  selectFixedH: 64,
  feather: 0,
  shapeKind: 'rect',
  shapeFill: true,
  shapeStroke: false,
  shapeStrokeWidth: 2,
  shapeRadius: 0,
  shapeNewLayer: true,
  shapeAntialias: true,
  gradientKind: 'linear',
  gradientToTransparent: false,
  gradientReverse: false,
  textFont: '-apple-system, Helvetica, Arial, sans-serif',
  textSize: 32,
  textBold: false,
  textItalic: false,
  textAntialias: true,
  moveAutoSelect: false,
  knifeDir: 'vertical',
  eyedropperMerged: true,
  cropDeletePixels: true,
};

export type DialogState =
  | { kind: 'new' }
  | { kind: 'image-size' }
  | { kind: 'canvas-size' }
  | { kind: 'filter'; filterId: string }
  | { kind: 'grid-slice' }
  | { kind: 'auto-slice' }
  | { kind: 'export'; source?: 'layers' | 'slices' | 'merged'; ids?: string[] }
  | { kind: 'select-modify'; op: 'grow' | 'shrink' | 'feather' | 'border' }
  | { kind: 'grid-settings' }
  | { kind: 'layer-style' }
  | { kind: 'color-range' }
  | { kind: 'cut-step' }
  | { kind: 'fill' }
  | { kind: 'curves' }
  | { kind: 'spritesheet'; source?: 'layers' | 'slices' | 'files'; ids?: string[] }
  | { kind: 'bmfont' }
  | { kind: 'new-guide' }
  | { kind: 'shortcuts' }
  | { kind: 'icon' }
  | { kind: 'pdf-import'; file: LoadedFile }
  | { kind: 'pdf-export' }
  | { kind: 'about' };

export interface ViewPrefs {
  pixelGrid: boolean;
  grid: boolean;
  gridW: number;
  gridH: number;
  gridColor: string;
  snap: boolean;
  slices: boolean;
  sliceLabels: boolean;
  checker: 'light' | 'dark';
  rulers: boolean;
  guides: boolean;
  lockGuides: boolean;
  /** Не давать прокрутить холст далеко за край картинки. */
  clampPan: boolean;
}

/** Область просмотра: свои вкладки и активный документ. Документ живёт ровно в одной области. */
export interface Pane {
  id: string;
  docIds: string[];
  activeId: string | null;
}

interface AppState {
  docs: Doc[];
  /** Активный документ сфокусированной области (синхронизируется в panes.ts). */
  activeId: string | null;
  panes: Pane[];
  focusedPane: string;
  /** h — области рядом (слева/справа), v — друг над другом. */
  split: 'h' | 'v';
  splitRatio: number;
  /** Счётчик для перерисовки React после изменения мутабельного Doc. */
  tick: number;
  tool: ToolId;
  fg: RGBA;
  bg: RGBA;
  recentColors: RGBA[];
  opts: ToolOptions;
  prefs: ViewPrefs;
  dialog: DialogState | null;
  toast: { text: string; kind: 'info' | 'error'; id: number } | null;
  busy: string | null;
  panels: { navigator: boolean; color: boolean; layers: boolean; slices: boolean; history: boolean; info: boolean; atlas: boolean; sprite: boolean; anims: boolean; atlasExport: boolean };
}

const savedOpts = (() => {
  try {
    return JSON.parse(localStorage.getItem('pixelyard.opts') ?? '{}') as Partial<ToolOptions>;
  } catch {
    return {};
  }
})();
const savedPrefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('pixelyard.prefs') ?? '{}') as Partial<ViewPrefs>;
  } catch {
    return {};
  }
})();

export const useApp = create<AppState>(() => ({
  docs: [],
  activeId: null,
  panes: [{ id: 'p1', docIds: [], activeId: null }],
  focusedPane: 'p1',
  split: 'h',
  splitRatio: 0.5,
  tick: 0,
  tool: 'brush',
  fg: [0, 0, 0, 255],
  bg: [255, 255, 255, 255],
  recentColors: [],
  opts: { ...DEFAULT_OPTIONS, ...savedOpts },
  prefs: {
    pixelGrid: true,
    grid: false,
    gridW: 32,
    gridH: 32,
    gridColor: 'rgba(0,180,255,0.35)',
    snap: false,
    slices: true,
    sliceLabels: true,
    checker: 'dark',
    rulers: true,
    guides: true,
    lockGuides: false,
    clampPan: true,
    ...savedPrefs,
  },
  dialog: null,
  toast: null,
  busy: null,
  panels: { navigator: true, color: true, layers: true, slices: true, history: true, info: true, atlas: true, sprite: true, anims: true, atlasExport: true },
}));

useApp.subscribe((s, prev) => {
  if (s.opts !== prev.opts) localStorage.setItem('pixelyard.opts', JSON.stringify(s.opts));
  if (s.prefs !== prev.prefs) localStorage.setItem('pixelyard.prefs', JSON.stringify(s.prefs));
});

/** Отдельный «быстрый» стор для координат курсора, чтобы не перерисовывать всё приложение. */
export const useCursor = create<{ x: number; y: number; inside: boolean; color: RGBA | null; size: string }>(() => ({
  x: 0,
  y: 0,
  inside: false,
  color: null,
  size: '',
}));

export const app = () => useApp.getState();

export function activeDoc(): Doc | null {
  const s = useApp.getState();
  return s.docs.find((d) => d.id === s.activeId) ?? null;
}

/** Сообщить UI и рендеру, что документ изменился. */
export function bump() {
  useApp.setState((s) => ({ tick: s.tick + 1 }));
}

export function setOpts(patch: Partial<ToolOptions>) {
  useApp.setState((s) => ({ opts: { ...s.opts, ...patch } }));
}

export function setPrefs(patch: Partial<ViewPrefs>) {
  useApp.setState((s) => ({ prefs: { ...s.prefs, ...patch } }));
}

let toastId = 0;
export function toast(text: string, kind: 'info' | 'error' = 'info') {
  const id = ++toastId;
  useApp.setState({ toast: { text, kind, id } });
  setTimeout(() => {
    if (useApp.getState().toast?.id === id) useApp.setState({ toast: null });
  }, kind === 'error' ? 6000 : 2500);
}

export function setFg(c: RGBA) {
  useApp.setState((s) => ({ fg: c, recentColors: pushRecent(s.recentColors, c) }));
}

export function setBg(c: RGBA) {
  useApp.setState({ bg: c });
}

function pushRecent(list: RGBA[], c: RGBA): RGBA[] {
  const same = (a: RGBA) => a[0] === c[0] && a[1] === c[1] && a[2] === c[2] && a[3] === c[3];
  return [c, ...list.filter((a) => !same(a))].slice(0, 16);
}

export function openDialog(d: DialogState) {
  useApp.setState({ dialog: d });
}

export function closeDialog() {
  useApp.setState({ dialog: null });
}
