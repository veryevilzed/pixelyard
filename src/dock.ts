import { create } from 'zustand';

/**
 * Раскладка боковых панелей: несколько колонок, панели перетаскиваются между ними.
 * Своя раскладка для обычных картинок и для атласов; хранится в localStorage.
 */

export type DockMode = 'image' | 'atlas';
export type PanelId = 'navigator' | 'color' | 'layers' | 'slices' | 'history' | 'atlas' | 'sprite' | 'anims' | 'atlasExport';

export const MODE_PANELS: Record<DockMode, PanelId[]> = {
  image: ['navigator', 'color', 'layers', 'slices', 'history'],
  atlas: ['navigator', 'atlas', 'sprite', 'anims', 'atlasExport', 'history'],
};

export const COL_MIN = 200;
export const COL_MAX = 560;
export const COL_DEFAULT = 280;

interface DockLayout {
  /** Колонки слева направо, в каждой — панели сверху вниз. */
  cols: PanelId[][];
  widths: number[];
}

interface DockState {
  layouts: Record<DockMode, DockLayout>;
}

const KEY = 'pixelyard.dock';

const defaults = (mode: DockMode): DockLayout => ({ cols: [MODE_PANELS[mode]], widths: [COL_DEFAULT] });

/** Чинит сохранённую раскладку: убирает чужие/повторные панели, добавляет недостающие, пустые колонки схлопывает. */
function normalize(mode: DockMode, l: DockLayout | undefined): DockLayout {
  if (!l || !Array.isArray(l.cols)) return defaults(mode);
  const allowed = new Set(MODE_PANELS[mode]);
  const seen = new Set<PanelId>();
  const cols: PanelId[][] = [];
  const widths: number[] = [];
  l.cols.forEach((c, i) => {
    const list = (Array.isArray(c) ? c : []).filter((p) => allowed.has(p) && !seen.has(p) && (seen.add(p), true));
    if (!list.length) return;
    cols.push(list);
    widths.push(Math.max(COL_MIN, Math.min(COL_MAX, Number(l.widths?.[i]) || COL_DEFAULT)));
  });
  if (!cols.length) return defaults(mode);
  const missing = MODE_PANELS[mode].filter((p) => !seen.has(p));
  if (missing.length) cols[cols.length - 1] = [...cols[cols.length - 1], ...missing];
  return { cols, widths };
}

function load(): DockState['layouts'] {
  let raw: Partial<Record<DockMode, DockLayout>> = {};
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    /* повреждённая раскладка — берём стандартную */
  }
  return { image: normalize('image', raw.image), atlas: normalize('atlas', raw.atlas) };
}

export const useDock = create<DockState>(() => ({ layouts: load() }));

useDock.subscribe((s, prev) => {
  if (s.layouts !== prev.layouts) localStorage.setItem(KEY, JSON.stringify(s.layouts));
});

function setLayout(mode: DockMode, l: DockLayout) {
  useDock.setState((s) => ({ layouts: { ...s.layouts, [mode]: normalize(mode, l) } }));
}

/**
 * Перенос панели: в колонку col на позицию index (индекс в колонке до удаления панели),
 * col = -1 — новая колонка слева, col = cols.length — новая колонка справа.
 */
export function movePanel(mode: DockMode, id: PanelId, col: number, index: number) {
  const l = useDock.getState().layouts[mode];
  const from = l.cols.findIndex((c) => c.includes(id));
  if (from < 0) return;
  const cols = l.cols.map((c) => [...c]);
  const widths = [...l.widths];
  const fromIdx = cols[from].indexOf(id);
  if (col < 0 || col >= cols.length) {
    cols[from].splice(fromIdx, 1);
    if (col < 0) {
      cols.unshift([id]);
      widths.unshift(COL_DEFAULT);
    } else {
      cols.push([id]);
      widths.push(COL_DEFAULT);
    }
  } else {
    let at = index;
    if (from === col && fromIdx < at) at--;
    cols[from].splice(fromIdx, 1);
    cols[col].splice(Math.max(0, Math.min(at, cols[col].length)), 0, id);
  }
  setLayout(mode, { cols, widths });
}

export function setColWidth(mode: DockMode, col: number, w: number) {
  const l = useDock.getState().layouts[mode];
  const widths = l.widths.map((x, i) => (i === col ? Math.round(Math.max(COL_MIN, Math.min(COL_MAX, w))) : x));
  useDock.setState((s) => ({ layouts: { ...s.layouts, [mode]: { ...l, widths } } }));
}

/** Одна колонка ↔ две (панели делятся пополам: вторая половина уходит в левую колонку). */
export function toggleTwoColumns(mode: DockMode) {
  const l = useDock.getState().layouts[mode];
  if (l.cols.length > 1) return setLayout(mode, { cols: [l.cols.flat()], widths: [Math.max(...l.widths)] });
  const all = l.cols[0];
  const half = Math.ceil(all.length / 2);
  setLayout(mode, { cols: [all.slice(half), all.slice(0, half)], widths: [COL_DEFAULT, l.widths[0]] });
}

export function resetDock(mode: DockMode) {
  setLayout(mode, defaults(mode));
}
