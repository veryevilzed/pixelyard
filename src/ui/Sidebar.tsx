import { ChevronRight, GripVertical } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { activeDoc, useApp } from '../store';
import { isAtlas } from '../core/atlasDoc';
import { movePanel, setColWidth, useDock, type DockMode, type PanelId } from '../dock';
import { AnimationsActions, AnimationsPanel, AtlasActions, AtlasExportPanel, AtlasPanel, SpritePanel } from './panels/AtlasPanel';
import { ColorPanel } from './panels/ColorPanel';
import { Navigator } from './panels/Navigator';
import { HistoryPanel } from './panels/HistoryPanel';
import { LayersActions, LayersPanel } from './panels/LayersPanel';
import { SlicesActions, SlicesPanel } from './panels/SlicesPanel';
import { NinePanel } from './panels/NinePanel';

interface PanelDef {
  title: string;
  body: () => ReactNode;
  actions?: () => ReactNode;
  grow?: boolean;
}

export const PANELS: Record<PanelId, PanelDef> = {
  navigator: { title: 'Навигатор', body: () => <Navigator /> },
  color: { title: 'Цвет', body: () => <ColorPanel /> },
  layers: { title: 'Слои', body: () => <LayersPanel />, actions: () => <LayersActions />, grow: true },
  slices: { title: 'Слайсы', body: () => <SlicesPanel />, actions: () => <SlicesActions /> },
  nine: { title: '9-slice', body: () => <NinePanel /> },
  history: { title: 'История', body: () => <HistoryPanel /> },
  atlas: { title: 'Спрайты', body: () => <AtlasPanel />, actions: () => <AtlasActions />, grow: true },
  sprite: { title: 'Свойства спрайта', body: () => <SpritePanel /> },
  anims: { title: 'Анимации', body: () => <AnimationsPanel />, actions: () => <AnimationsActions /> },
  atlasExport: { title: 'Выгрузка', body: () => <AtlasExportPanel /> },
};

// ---------- перетаскивание панелей ----------

/** col = -1 — новая колонка слева. */
interface DropTarget {
  col: number;
  index: number;
}
const usePanelDrag = create<{ id: PanelId | null; x: number; y: number; target: DropTarget | null }>(() => ({ id: null, x: 0, y: 0, target: null }));

/** Куда упадёт панель: полоса «+» слева, колонка под курсором, позиция по середине панелей. */
function dropTarget(x: number, y: number): DropTarget | null {
  const plus = document.querySelector('.dock-new-col')?.getBoundingClientRect();
  if (plus && x >= plus.left - 40 && x < plus.right) return { col: -1, index: 0 };
  const cols = [...document.querySelectorAll<HTMLElement>('.dock .sidebar')];
  for (const [ci, el] of cols.entries()) {
    const r = el.getBoundingClientRect();
    if (x < r.left || x >= r.right) continue;
    const panels = [...el.querySelectorAll<HTMLElement>(':scope > .panel')];
    let index = panels.length;
    for (const [pi, p] of panels.entries()) {
      const pr = p.getBoundingClientRect();
      if (y < pr.top + Math.min(pr.height / 2, 40)) {
        index = pi;
        break;
      }
    }
    return { col: ci, index };
  }
  return null;
}

function startPanelDrag(e: React.PointerEvent, mode: DockMode, id: PanelId, onClick: () => void) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    dragging = true;
    usePanelDrag.setState({ id, x: ev.clientX, y: ev.clientY, target: dropTarget(ev.clientX, ev.clientY) });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const t = usePanelDrag.getState().target;
    usePanelDrag.setState({ id: null, target: null });
    if (!dragging) return onClick();
    if (t) movePanel(mode, id, t.col, t.index);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function Panel({ id, mode, dropBefore }: { id: PanelId; mode: DockMode; dropBefore: boolean }) {
  const def = PANELS[id];
  const open = useApp((s) => s.panels[id]);
  const dragged = usePanelDrag((s) => s.id === id);
  const toggle = () => useApp.setState((s) => ({ panels: { ...s.panels, [id]: !s.panels[id] } }));
  return (
    <div className={`panel ${open && def.grow ? 'grow' : ''} ${dragged ? 'dragged' : ''} ${dropBefore ? 'drop-before' : ''}`} data-panel={id}>
      <div className="panel-head" onPointerDown={(e) => startPanelDrag(e, mode, id, toggle)} title="Клик — свернуть, перетаскивание — в другое место или колонку">
        <ChevronRight size={12} className={`chev ${open ? 'open' : ''}`} />
        {def.title}
        <GripVertical size={12} className="grip" />
        {open && def.actions && (
          <span className="actions" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            {def.actions()}
          </span>
        )}
      </div>
      {open && def.body()}
    </div>
  );
}

/** Ручка ширины колонки — у её левого края. */
function ColResizer({ mode, col, width }: { mode: DockMode; col: number; width: number }) {
  const [active, setActive] = useState(false);
  return (
    <div
      className={`dock-resizer ${active ? 'active' : ''}`}
      onPointerDown={(e) => {
        const sx = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setActive(true);
        const move = (ev: PointerEvent) => setColWidth(mode, col, width + (sx - ev.clientX));
        const up = () => {
          setActive(false);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

export function Sidebar() {
  useApp((s) => s.tick);
  // атлас: свои панели вместо цвета, слоёв и слайсов
  const mode: DockMode = isAtlas(activeDoc()) ? 'atlas' : 'image';
  const layout = useDock((s) => s.layouts[mode]);
  const drag = usePanelDrag();
  const t = drag.target;
  return (
    <div className={`dock ${drag.id ? 'dragging' : ''}`}>
      {drag.id && <div className={`dock-new-col ${t?.col === -1 ? 'hot' : ''}`}>+</div>}
      {layout.cols.map((col, ci) => (
        <div key={ci} className={`sidebar ${mode === 'atlas' ? 'atlas-side' : ''} ${t && t.col === ci ? 'drop-col' : ''}`} style={{ width: layout.widths[ci] }}>
          <ColResizer mode={mode} col={ci} width={layout.widths[ci]} />
          {col.map((id, pi) => (
            <Panel key={id} id={id} mode={mode} dropBefore={!!t && t.col === ci && t.index === pi} />
          ))}
          <div className={`dock-tail ${t && t.col === ci && t.index === col.length ? 'drop-before' : ''}`} />
        </div>
      ))}
      {drag.id && (
        <div className="panel-ghost" style={{ left: drag.x + 12, top: drag.y + 8 }}>
          {PANELS[drag.id].title}
        </div>
      )}
    </div>
  );
}
