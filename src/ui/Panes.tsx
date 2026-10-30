import { Columns2, Combine, Rows2, X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { create } from 'zustand';
import { closeDoc, switchDoc } from '../actions';
import { mergePanes, moveDoc, splitActive, splitWith, type SplitSide } from '../panes';
import { useApp, type Pane } from '../store';
import { changed } from '../tools/base';
import { Viewport } from './Viewport';

// ---------- перетаскивание вкладок ----------

type DropTarget =
  | { kind: 'tab'; paneId: string; index: number; line: { x: number; y: number; h: number } }
  | { kind: 'pane'; paneId: string; side: SplitSide | 'center'; rect: { x: number; y: number; w: number; h: number } };

const useTabDrag = create<{ docId: string | null; name: string; x: number; y: number; target: DropTarget | null }>(() => ({
  docId: null,
  name: '',
  x: 0,
  y: 0,
  target: null,
}));

function findTarget(x: number, y: number, docId: string): DropTarget | null {
  const s = useApp.getState();
  const from = s.panes.find((p) => p.docIds.includes(docId));
  const els = document.elementsFromPoint(x, y) as HTMLElement[];
  const bar = els.map((e) => e.closest<HTMLElement>('[data-tabbar]')).find(Boolean);
  if (bar) {
    const paneId = bar.dataset.tabbar!;
    const tabs = Array.from(bar.querySelectorAll<HTMLElement>('[data-tab]'));
    const br = bar.getBoundingClientRect();
    let index = tabs.length;
    let lineX = tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right : br.left;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        lineX = r.left;
        break;
      }
    }
    return { kind: 'tab', paneId, index, line: { x: lineX, y: br.top, h: br.height } };
  }
  const vp = els.map((e) => e.closest<HTMLElement>('.viewport[data-pane]')).find(Boolean);
  if (!vp || !from) return null;
  const paneId = vp.dataset.pane!;
  const r = vp.getBoundingClientRect();
  const edgeX = Math.min(r.width * 0.25, 160), edgeY = Math.min(r.height * 0.25, 160);
  let side: SplitSide | 'center' = 'center';
  if (x < r.left + edgeX) side = 'left';
  else if (x > r.right - edgeX) side = 'right';
  else if (y < r.top + edgeY) side = 'top';
  else if (y > r.bottom - edgeY) side = 'bottom';
  // разделить можно, только если в исходной области останется хоть одна вкладка
  if (side !== 'center' && s.panes.length === 1 && from.docIds.length < 2) side = 'center';
  if (side === 'center' && paneId === from.id) return null;
  const rect =
    side === 'left' ? { x: r.left, y: r.top, w: r.width / 2, h: r.height }
    : side === 'right' ? { x: r.left + r.width / 2, y: r.top, w: r.width / 2, h: r.height }
    : side === 'top' ? { x: r.left, y: r.top, w: r.width, h: r.height / 2 }
    : side === 'bottom' ? { x: r.left, y: r.top + r.height / 2, w: r.width, h: r.height / 2 }
    : { x: r.left, y: r.top, w: r.width, h: r.height };
  return { kind: 'pane', paneId, side, rect };
}

function startTabDrag(e: React.PointerEvent, docId: string, name: string) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  let active = false;
  const move = (ev: PointerEvent) => {
    if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    active = true;
    useTabDrag.setState({ docId, name, x: ev.clientX, y: ev.clientY, target: findTarget(ev.clientX, ev.clientY, docId) });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const { target } = useTabDrag.getState();
    useTabDrag.setState({ docId: null, target: null });
    if (!active || !target) return;
    if (target.kind === 'tab') moveDoc(docId, target.paneId, target.index);
    else if (target.side === 'center') {
      const pane = useApp.getState().panes.find((p) => p.id === target.paneId);
      if (pane) moveDoc(docId, pane.id, pane.docIds.length);
    } else splitWith(docId, target.side);
    changed();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Призрак вкладки у курсора и подсветка места, куда она упадёт. */
export function TabDragLayer() {
  const d = useTabDrag();
  if (!d.docId) return null;
  const t = d.target;
  return (
    <>
      {t?.kind === 'tab' && <div className="tab-drop-line" style={{ left: t.line.x - 1, top: t.line.y, height: t.line.h }} />}
      {t?.kind === 'pane' && (
        <div className="pane-drop-zone" style={{ left: t.rect.x, top: t.rect.y, width: t.rect.w, height: t.rect.h }}>
          <span>{t.side === 'center' ? 'Переместить сюда' : 'Разделить экран'}</span>
        </div>
      )}
      <div className="tab-ghost" style={{ left: d.x + 12, top: d.y + 8 }}>
        {d.name}
      </div>
    </>
  );
}

// ---------- вкладки области ----------

function TabBar({ pane, focused, split }: { pane: Pane; focused: boolean; split: boolean }) {
  const docs = useApp((s) => s.docs);
  const panesCount = useApp((s) => s.panes.length);
  const dragId = useTabDrag((s) => s.docId);
  useApp((s) => s.tick);
  return (
    <div className={`tabs ${split && focused ? 'focused' : ''}`} data-tabbar={pane.id}>
      {pane.docIds.map((id) => {
        const d = docs.find((x) => x.id === id);
        if (!d) return null;
        return (
          <div
            key={d.id}
            data-tab={d.id}
            className={`tab ${d.id === pane.activeId ? 'active' : ''} ${dragId === d.id ? 'dragging' : ''}`}
            title={`${d.path ?? d.name}\nПеретащите к краю холста, чтобы разделить экран`}
            onPointerDown={(e) => {
              if (e.button === 1) return;
              if (d.id !== useApp.getState().activeId) switchDoc(d.id);
              startTabDrag(e, d.id, d.name);
            }}
            onAuxClick={(e) => e.button === 1 && void closeDoc(d.id)}
          >
            <span className="name">
              {d.name}
              {d.dirty ? ' •' : ''}
            </span>
            <span style={{ color: 'var(--text-faint)' }}>{Math.round(d.view.zoom * 100)}%</span>
            <span
              className="close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void closeDoc(d.id);
              }}
            >
              <X size={11} />
            </span>
          </div>
        );
      })}
      <span className="tabs-actions">
        {panesCount === 1 && pane.docIds.length > 1 && (
          <>
            <button className="icon-btn" title="Разделить: активный документ — вправо" onClick={() => splitActive('h')}>
              <Columns2 size={13} />
            </button>
            <button className="icon-btn" title="Разделить: активный документ — вниз" onClick={() => splitActive('v')}>
              <Rows2 size={13} />
            </button>
          </>
        )}
        {panesCount > 1 && (
          <button className="icon-btn" title="Объединить области в одну" onClick={mergePanes}>
            <Combine size={13} />
          </button>
        )}
      </span>
    </div>
  );
}

function PaneView({ pane, split, empty }: { pane: Pane; split: boolean; empty: ReactNode }) {
  const focused = useApp((s) => s.focusedPane === pane.id);
  const hasDocs = useApp((s) => s.docs.length > 0);
  return (
    <div className={`pane ${split && focused ? 'focused' : ''}`}>
      {pane.docIds.length > 0 && <TabBar pane={pane} focused={focused} split={split} />}
      <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
        <Viewport paneId={pane.id} />
        {!hasDocs && empty}
      </div>
    </div>
  );
}

/** Центральная область: одна или две области просмотра с перетаскиваемым разделителем. */
export function Workspace({ empty }: { empty: ReactNode }) {
  const panes = useApp((s) => s.panes);
  const split = useApp((s) => s.split);
  const ratio = useApp((s) => s.splitRatio);
  const ref = useRef<HTMLDivElement>(null);
  if (panes.length === 1) return <div className="center"><PaneView pane={panes[0]} split={false} empty={empty} /></div>;
  const horizontal = split === 'h';
  const dragSplitter = (e: React.PointerEvent) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const k = horizontal ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      useApp.setState({ splitRatio: Math.min(0.85, Math.max(0.15, k)) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="center split" ref={ref} style={{ flexDirection: horizontal ? 'row' : 'column' }}>
      <div style={{ flex: `${ratio} 1 0`, display: 'flex', minWidth: 0, minHeight: 0 }}>
        <PaneView pane={panes[0]} split empty={empty} />
      </div>
      <div className={`splitter ${horizontal ? 'h' : 'v'}`} onPointerDown={dragSplitter} onDoubleClick={() => useApp.setState({ splitRatio: 0.5 })} title="Перетащите, чтобы изменить размер; двойной клик — поровну" />
      <div style={{ flex: `${1 - ratio} 1 0`, display: 'flex', minWidth: 0, minHeight: 0 }}>
        <PaneView pane={panes[1]} split empty={empty} />
      </div>
    </div>
  );
}
