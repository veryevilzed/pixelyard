import { uid } from './core/canvas';
import { useApp, type Pane } from './store';

/**
 * Операции с областями просмотра (сплит). Инвариант: областей 1 или 2,
 * каждый документ — ровно в одной области, activeId = активный документ
 * сфокусированной области.
 */

/** Размеры областей просмотра в CSS-пикселях — их выставляет Viewport. */
export const paneSizes = new Map<string, { w: number; h: number }>();

export function paneSize(paneId: string) {
  return paneSizes.get(paneId) ?? { w: 1200, h: 800 };
}

export function paneOf(docId: string): Pane | null {
  return useApp.getState().panes.find((p) => p.docIds.includes(docId)) ?? null;
}

/** Размер области, где показан документ (или сфокусированной). */
export function sizeForDoc(docId: string | null) {
  const s = useApp.getState();
  const pane = (docId && paneOf(docId)) || s.panes.find((p) => p.id === s.focusedPane);
  return paneSize(pane?.id ?? s.focusedPane);
}

function commit(panes: Pane[], focusedPane: string) {
  // пустые области схлопываются, пока остаётся хотя бы одна
  let list = panes.filter((p) => p.docIds.length > 0);
  if (!list.length) list = [{ ...panes[0], docIds: [], activeId: null }];
  for (const p of list) if (!p.activeId || !p.docIds.includes(p.activeId)) p.activeId = p.docIds[p.docIds.length - 1] ?? null;
  const focus = list.find((p) => p.id === focusedPane) ?? list[0];
  useApp.setState({ panes: list, focusedPane: focus.id, activeId: focus.activeId });
}

/** Документ попал в область другого размера — вид подгоняется заново при отрисовке. */
function refit(docId: string) {
  const d = useApp.getState().docs.find((x) => x.id === docId);
  if (d) d.needsFit = true;
}

const clonePanes = () => useApp.getState().panes.map((p) => ({ ...p, docIds: [...p.docIds] }));

export function addDocToFocused(docId: string) {
  const s = useApp.getState();
  const panes = clonePanes();
  const pane = panes.find((p) => p.id === s.focusedPane) ?? panes[0];
  pane.docIds.push(docId);
  pane.activeId = docId;
  commit(panes, pane.id);
}

export function removeDocFromPanes(docId: string) {
  const panes = clonePanes();
  for (const p of panes) {
    const i = p.docIds.indexOf(docId);
    if (i < 0) continue;
    p.docIds.splice(i, 1);
    // как в браузере: активной становится соседняя вкладка
    if (p.activeId === docId) p.activeId = p.docIds[Math.min(i, p.docIds.length - 1)] ?? null;
  }
  commit(panes, useApp.getState().focusedPane);
}

export function activateDoc(docId: string) {
  const panes = clonePanes();
  const pane = panes.find((p) => p.docIds.includes(docId));
  if (!pane) return;
  pane.activeId = docId;
  commit(panes, pane.id);
}

export function focusPane(paneId: string) {
  if (useApp.getState().focusedPane === paneId) return;
  commit(clonePanes(), paneId);
}

/** Переносит вкладку в область toPane на позицию index (в той же области — смена порядка). */
export function moveDoc(docId: string, toPane: string, index: number) {
  const panes = clonePanes();
  const from = panes.find((p) => p.docIds.includes(docId));
  const to = panes.find((p) => p.id === toPane);
  if (!from || !to) return;
  const oldIndex = from.docIds.indexOf(docId);
  from.docIds.splice(oldIndex, 1);
  if (from === to && oldIndex < index) index--;
  to.docIds.splice(Math.max(0, Math.min(index, to.docIds.length)), 0, docId);
  to.activeId = docId;
  if (from !== to) refit(docId);
  const emptied = from !== to && from.docIds.length === 0;
  commit(panes, to.id);
  // область исчезла — оставшаяся стала шире, её документы тоже подгоняем
  if (emptied) for (const id of to.docIds) refit(id);
}

export type SplitSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * Разделяет экран: документ уходит в новую область с указанной стороны.
 * Если областей уже две — документ переносится в ту, что с этой стороны.
 */
export function splitWith(docId: string, side: SplitSide) {
  const s = useApp.getState();
  const panes = clonePanes();
  const from = panes.find((p) => p.docIds.includes(docId));
  if (!from) return;
  const dir = side === 'left' || side === 'right' ? 'h' : 'v';
  const first = side === 'left' || side === 'top';
  if (panes.length === 2) {
    // бросили к краю — области выстраиваются в этом направлении, документ уходит в область с той стороны
    if (s.split !== dir) useApp.setState({ split: dir });
    const target = first ? panes[0] : panes[1];
    if (target !== from) moveDoc(docId, target.id, target.docIds.length);
    return;
  }
  if (from.docIds.length < 2) return; // нечего оставить в исходной области
  from.docIds.splice(from.docIds.indexOf(docId), 1);
  const pane: Pane = { id: uid('pane'), docIds: [docId], activeId: docId };
  const list = first ? [pane, from] : [from, pane];
  // обе области стали уже — подгоняем все их документы
  for (const id of [...from.docIds, docId]) refit(id);
  useApp.setState({ split: dir, splitRatio: 0.5 });
  commit(list, pane.id);
}

/** Разделить: активный документ — в новую область справа/снизу. */
export function splitActive(dir: 'h' | 'v') {
  const id = useApp.getState().activeId;
  if (id) splitWith(id, dir === 'h' ? 'right' : 'bottom');
}

/** Объединить все области в одну. */
export function mergePanes() {
  const s = useApp.getState();
  if (s.panes.length < 2) return;
  const focused = s.panes.find((p) => p.id === s.focusedPane)!;
  const all = s.panes.flatMap((p) => p.docIds);
  all.forEach(refit);
  commit([{ id: s.panes[0].id, docIds: all, activeId: focused.activeId }], s.panes[0].id);
}

/** Переключение вкладок в сфокусированной области (⌃Tab / ⌃⇧Tab). */
export function cycleTab(dir: 1 | -1) {
  const s = useApp.getState();
  const pane = s.panes.find((p) => p.id === s.focusedPane);
  if (!pane || pane.docIds.length < 2 || !pane.activeId) return;
  const i = pane.docIds.indexOf(pane.activeId);
  activateDoc(pane.docIds[(i + dir + pane.docIds.length) % pane.docIds.length]);
}
