import { ArrowDown, ArrowUp, Copy, CornerLeftDown, Download, Eye, EyeOff, Lock, LockOpen, Merge, Plus, SquareDashed, Trash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as A from '../../actions';
import { ctx2d } from '../../core/canvas';
import { selectionFromAlpha } from '../../core/selection';
import { BLEND_MODES, hasEffects, type BlendMode } from '../../core/types';
import { activeDoc, openDialog, useApp } from '../../store';
import { changed } from '../../tools/base';
import { NumberField } from '../controls';

function Thumb({ canvas, rev, w, h, active, gray, onClick, title }: { canvas: HTMLCanvasElement; rev: number; w: number; h: number; active?: boolean; gray?: boolean; onClick?: (e: React.MouseEvent) => void; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = Math.min(32 / w, 32 / h);
    const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
    const ctx = ctx2d(c);
    ctx.clearRect(0, 0, 32, 32);
    ctx.imageSmoothingEnabled = k < 1;
    const x = Math.floor((32 - dw) / 2), y = Math.floor((32 - dh) / 2);
    if (gray) {
      // маска показывается как ч/б картинка: белое — видно, чёрное — скрыто
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, dw, dh);
      const t = document.createElement('canvas');
      t.width = dw;
      t.height = dh;
      const tc = ctx2d(t);
      tc.drawImage(canvas, 0, 0, dw, dh);
      tc.globalCompositeOperation = 'source-in';
      tc.fillStyle = '#fff';
      tc.fillRect(0, 0, dw, dh);
      ctx.drawImage(t, x, y);
    } else ctx.drawImage(canvas, x, y, dw, dh);
  }, [canvas, rev, w, h, gray]);
  return <canvas ref={ref} width={32} height={32} className={`layer-thumb ${active ? 'target' : ''}`} onClick={onClick} title={title} />;
}

export function LayersPanel() {
  useApp((s) => s.tick);
  const doc = activeDoc();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number | null } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  if (!doc) return <div className="panel-body note">Нет документа</div>;
  const active = doc.activeLayer;
  const rows = [...doc.layers].reverse();

  const select = (id: string) => {
    if (doc.activeLayerId === id) return;
    doc.activeLayerId = id;
    changed();
  };

  // перетаскивание для смены порядка — на pointer-событиях (без HTML5 DnD)
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || renaming) return;
    const startY = e.clientY;
    let moved = false;
    let over: number | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 5) return;
      moved = true;
      const els = Array.from(listRef.current?.querySelectorAll('.layer-row') ?? []);
      over = els.length;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          over = i;
          break;
        }
      }
      setDrag({ id, over });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!moved || over === null) return;
      // over — позиция вставки в перевёрнутом списке (0 = самый верх)
      const from = rows.findIndex((l) => l.id === id);
      let to = over > from ? over - 1 : over;
      to = Math.max(0, Math.min(rows.length - 1, to));
      if (to !== from) {
        doc.moveLayer(id, rows.length - 1 - to);
        changed();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {active && (
        <div className="layer-props wrap">
          <select
            value={active.blend}
            onChange={(e) => {
              doc.updateLayer(active.id, { blend: e.target.value as BlendMode }, 'Режим наложения');
              changed();
            }}
          >
            {BLEND_MODES.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
          <NumberField
            label="Непрозр."
            value={Math.round(active.opacity * 100)}
            min={0}
            max={100}
            width={46}
            suffix="%"
            onChange={(v) => {
              // подряд идущие изменения прозрачности одного слоя схлопываются в одну запись истории
              const last = doc.undoStack[doc.undoStack.length - 1];
              if (last?.label === 'Непрозрачность слоя' && last.after?.activeLayerId === active.id && last.after.layers === doc.layers) doc.undo();
              doc.updateLayer(active.id, { opacity: v / 100 }, 'Непрозрачность слоя');
              changed();
            }}
          />
          <NumberField
            label="Заливка"
            title="Непрозрачность заливки: гасит пиксели слоя, но не его эффекты"
            value={Math.round(active.fillOpacity * 100)}
            min={0}
            max={100}
            width={46}
            suffix="%"
            onChange={(v) => {
              const last = doc.undoStack[doc.undoStack.length - 1];
              if (last?.label === 'Непрозрачность заливки' && last.after?.layers === doc.layers) doc.undo();
              doc.updateLayer(active.id, { fillOpacity: v / 100 }, 'Непрозрачность заливки');
              changed();
            }}
          />
        </div>
      )}
      {doc.editingMask && <div className="mask-hint">Рисование по маске: чёрный — скрыть, белый — показать</div>}
      <div className="panel-body list" ref={listRef}>
        {rows.map((l, i) => {
          const dropCls = drag && drag.over !== null && drag.id !== l.id ? (drag.over === i ? 'drop-above' : drag.over === i + 1 && i === rows.length - 1 ? 'drop-below' : '') : '';
          return (
            <div
              key={l.id}
              className={`layer-row ${l.id === doc.activeLayerId ? 'active' : ''} ${l.visible ? '' : 'hidden'} ${dropCls}`}
              onPointerDown={(e) => {
                select(l.id);
                startDrag(e, l.id);
              }}
            >
              <button
                className="icon-btn"
                title="Показать/скрыть (Alt+клик — только этот)"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  if (e.altKey) {
                    const solo = doc.layers.every((x) => x.id === l.id || !x.visible);
                    doc.change('Видимость слоёв', () => {
                      doc.layers = doc.layers.map((x) => ({ ...x, visible: solo ? true : x.id === l.id }));
                    });
                  } else doc.updateLayer(l.id, { visible: !l.visible }, l.visible ? 'Скрыть слой' : 'Показать слой');
                  changed();
                }}
              >
                {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              {l.clip && <CornerLeftDown size={12} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />}
              <Thumb
                canvas={l.canvas}
                rev={doc.rev}
                w={doc.width}
                h={doc.height}
                active={!!l.mask && l.id === doc.activeLayerId && !doc.editMask}
                title="Клик — рисовать по пикселям, ⌘+клик — выделить непрозрачные пиксели"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) {
                    doc.setSelection(selectionFromAlpha(l.canvas), 'Выделить непрозрачные пиксели');
                  }
                  doc.editMask = false;
                  changed();
                }}
              />
              {l.mask && (
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <Thumb
                    canvas={l.mask}
                    gray
                    rev={doc.rev}
                    w={doc.width}
                    h={doc.height}
                    active={l.id === doc.activeLayerId && doc.editMask}
                    title="Клик — рисовать по маске (чёрный скрывает, белый показывает), ⇧+клик — отключить, ⌘+клик — выделение из маски"
                    onClick={(e) => {
                      e.stopPropagation();
                      select(l.id);
                      if (e.shiftKey) {
                        doc.updateLayer(l.id, { maskEnabled: !l.maskEnabled }, l.maskEnabled ? 'Отключить маску' : 'Включить маску');
                      } else if (e.metaKey || e.ctrlKey) {
                        doc.setSelection(selectionFromAlpha(l.mask!), 'Выделение из маски');
                      } else doc.editMask = true;
                      changed();
                    }}
                  />
                  {!l.maskEnabled && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f44', fontSize: 22, pointerEvents: 'none' }}>✕</span>}
                </span>
              )}
              {renaming === l.id ? (
                <input
                  type="text"
                  autoFocus
                  defaultValue={l.name}
                  style={{ flex: 1, minWidth: 0 }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    setRenaming(null);
                    if (v && v !== l.name) {
                      doc.updateLayer(l.id, { name: v }, 'Переименовать слой');
                      changed();
                    }
                  }}
                />
              ) : (
                <span className="layer-name" onDoubleClick={() => setRenaming(l.id)} title="Двойной клик — переименовать">
                  {l.name}
                  {l.opacity < 1 && <span style={{ color: 'var(--text-faint)' }}> · {Math.round(l.opacity * 100)}%</span>}
                  {l.blend !== 'normal' && <span style={{ color: 'var(--text-faint)' }}> · {BLEND_MODES.find((b) => b.id === l.blend)?.label}</span>}
                </span>
              )}
              {hasEffects(l.effects) && (
                <button className="icon-btn fx on" title="Стиль слоя" onPointerDown={(e) => e.stopPropagation()} onClick={() => { select(l.id); openDialog({ kind: 'layer-style' }); }}>
                  fx
                </button>
              )}
              <button
                className={`icon-btn ${l.locked ? 'on' : ''}`}
                title={l.locked ? 'Разблокировать' : 'Заблокировать'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  doc.updateLayer(l.id, { locked: !l.locked }, l.locked ? 'Разблокировать слой' : 'Заблокировать слой');
                  changed();
                }}
              >
                {l.locked ? <Lock size={13} /> : <LockOpen size={13} style={{ opacity: 0.35 }} />}
              </button>
              <button
                className="icon-btn"
                title="Экспортировать этот слой"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => openDialog({ kind: 'export', source: 'layers', ids: [l.id] })}
              >
                <Download size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function LayersActions() {
  useApp((s) => s.tick);
  const doc = activeDoc();
  const n = doc?.layers.length ?? 0;
  const idx = doc?.activeLayerId ? doc.layerIndex(doc.activeLayerId) : -1;
  return (
    <>
      <button className="icon-btn" title="Новый слой (⇧⌘N)" disabled={!doc} onClick={A.newLayer}>
        <Plus size={14} />
      </button>
      <button className="icon-btn" title="Дублировать" disabled={idx < 0} onClick={A.duplicateLayer}>
        <Copy size={13} />
      </button>
      <button className="icon-btn" title="Поднять (⌘])" disabled={idx < 0 || idx >= n - 1} onClick={() => A.moveLayerBy(1)}>
        <ArrowUp size={13} />
      </button>
      <button className="icon-btn" title="Опустить (⌘[)" disabled={idx <= 0} onClick={() => A.moveLayerBy(-1)}>
        <ArrowDown size={13} />
      </button>
      <button className="icon-btn fx" title="Стиль слоя: тень, обводка, свечение, наложение" disabled={idx < 0} onClick={() => openDialog({ kind: 'layer-style' })}>
        fx
      </button>
      <button
        className="icon-btn"
        title="Маска слоя (из выделения, если оно есть)"
        disabled={idx < 0}
        onClick={() => (doc?.activeLayer?.mask ? A.setEditMask(true) : A.addMask(doc?.selection ? 'selection' : 'reveal'))}
      >
        <SquareDashed size={13} />
      </button>
      <button className={`icon-btn ${doc?.activeLayer?.clip ? 'on' : ''}`} title="Обтравочная маска (⌥⌘G)" disabled={idx < 0} onClick={A.toggleClip}>
        <CornerLeftDown size={13} />
      </button>
      <button className="icon-btn" title="Объединить с нижним (⌘E)" disabled={idx <= 0} onClick={A.mergeDown}>
        <Merge size={13} />
      </button>
      <button className="icon-btn" title="Удалить слой" disabled={n <= 1} onClick={A.deleteLayer}>
        <Trash size={13} />
      </button>
      <button className="icon-btn" title="Экспорт слоёв в отдельные файлы" disabled={!doc} onClick={() => openDialog({ kind: 'export', source: 'layers' })}>
        <Download size={13} />
      </button>
    </>
  );
}
