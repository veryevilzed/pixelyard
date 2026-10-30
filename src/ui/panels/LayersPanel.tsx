import { ArrowDown, ArrowUp, ChevronRight, Copy, CornerLeftDown, Download, Eye, EyeOff, Folder, FolderOpen, FolderPlus, Lock, LockOpen, Merge, Plus, SquareDashed, Trash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as A from '../../actions';
import { ctx2d } from '../../core/canvas';
import { selectionFromAlpha } from '../../core/selection';
import { BLEND_MODES, hasEffects, LABEL_COLORS, labelCss, type BlendMode, type LabelColor } from '../../core/types';
import type { Doc } from '../../core/doc';
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
  const [drag, setDrag] = useState<{ id: string; over: number | null; group: string | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; layerId?: string; groupId?: string } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  if (!doc) return <div className="panel-body note">Нет документа</div>;
  const active = doc.activeLayer;
  const rows = [...doc.layers].reverse();

  const select = (id: string) => {
    if (doc.activeLayerId === id && !doc.activeGroupId) return;
    doc.activeLayerId = id;
    doc.activeGroupId = null;
    changed();
  };
  const activeGroup = doc.getGroup(doc.activeGroupId);

  // перетаскивание для смены порядка — на pointer-событиях (без HTML5 DnD)
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || renaming) return;
    const startY = e.clientY;
    let moved = false;
    let over: number | null = null;
    let group: string | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 5) return;
      moved = true;
      // над заголовком папки — положить в неё
      const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('.group-row') as HTMLElement | null;
      group = hit?.dataset.group ?? null;
      const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.layer-row[data-index]') ?? []);
      over = rows.length;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          over = Number(el.dataset.index);
          break;
        }
      }
      setDrag({ id, over: group ? null : over, group });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (moved && group) {
        doc.moveLayerToGroup(id, group);
        return changed();
      }
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

  const groupProps = activeGroup && (
    <div className="layer-props wrap">
      <Folder size={13} style={{ color: labelCss(activeGroup.color) ?? 'var(--text-dim)', flexShrink: 0 }} />
      <span className="layer-name">{activeGroup.name}</span>
      <NumberField
        label="Непрозр."
        value={Math.round(activeGroup.opacity * 100)}
        min={0}
        max={100}
        width={46}
        suffix="%"
        onChange={(v) => {
          const last = doc.undoStack[doc.undoStack.length - 1];
          if (last?.label === 'Непрозрачность папки' && last.after?.groups === doc.groups) doc.undo();
          doc.updateGroup(activeGroup.id, { opacity: v / 100 }, 'Непрозрачность папки');
          changed();
        }}
      />
      <button className="btn small" onClick={() => (doc.ungroup(activeGroup.id), (doc.activeGroupId = null), changed())}>Разгруппировать</button>
    </div>
  );

  // строки: заголовок папки перед её первым (верхним) слоем, слои свёрнутой папки скрыты
  const items: ({ kind: 'layer'; l: (typeof rows)[number]; i: number; inGroup: boolean } | { kind: 'group'; id: string })[] = [];
  const seen = new Set<string>();
  rows.forEach((l, i) => {
    const g = doc.getGroup(l.group);
    if (g && !seen.has(g.id)) {
      seen.add(g.id);
      items.push({ kind: 'group', id: g.id });
    }
    if (!g || !g.collapsed) items.push({ kind: 'layer', l, i, inGroup: !!g });
  });

  return (
    <>
      {groupProps}
      {active && !activeGroup && (
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
      <div className="panel-body list" ref={listRef} style={{ minHeight: 180, maxHeight: "50vh" }} onPointerDown={() => setMenu(null)}>
        {items.map((it) => {
          if (it.kind === 'group') {
            const g = doc.getGroup(it.id)!;
            const color = labelCss(g.color);
            return (
              <div
                key={g.id}
                data-group={g.id}
                className={`group-row ${doc.activeGroupId === g.id ? 'active' : ''} ${drag?.group === g.id ? 'drop-into' : ''} ${g.visible ? '' : 'hidden'}`}
                style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
                onPointerDown={() => {
                  doc.activeGroupId = g.id;
                  changed();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, groupId: g.id });
                }}
              >
                <button className="icon-btn" title={g.visible ? 'Скрыть папку' : 'Показать папку'} onPointerDown={(e) => e.stopPropagation()} onClick={() => (doc.updateGroup(g.id, { visible: !g.visible }, g.visible ? 'Скрыть папку' : 'Показать папку'), changed())}>
                  {g.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button className="icon-btn" title="Свернуть / развернуть" onPointerDown={(e) => e.stopPropagation()} onClick={() => (doc.updateGroup(g.id, { collapsed: !g.collapsed }, g.collapsed ? 'Развернуть папку' : 'Свернуть папку'), changed())}>
                  <ChevronRight size={13} className={`chev ${g.collapsed ? '' : 'open'}`} />
                </button>
                {g.collapsed ? <Folder size={14} style={{ color: color ?? 'var(--text-dim)', flexShrink: 0 }} /> : <FolderOpen size={14} style={{ color: color ?? 'var(--text-dim)', flexShrink: 0 }} />}
                {renamingGroup === g.id ? (
                  <input
                    type="text"
                    autoFocus
                    defaultValue={g.name}
                    style={{ flex: 1, minWidth: 0 }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenamingGroup(null);
                    }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      setRenamingGroup(null);
                      if (v && v !== g.name) (doc.updateGroup(g.id, { name: v }, 'Переименовать папку'), changed());
                    }}
                  />
                ) : (
                  <span className="layer-name" onDoubleClick={() => setRenamingGroup(g.id)} title="Двойной клик — переименовать, правый клик — цвет и действия">
                    {g.name}
                    {g.opacity < 1 && <span style={{ color: 'var(--text-faint)' }}> · {Math.round(g.opacity * 100)}%</span>}
                  </span>
                )}
                <span className="dim-count">{doc.layers.filter((x) => x.group === g.id).length}</span>
              </div>
            );
          }
          const { l, i, inGroup } = it;
          const color = labelCss(l.color);
          const dropCls = drag && drag.over !== null && drag.id !== l.id ? (drag.over === i ? 'drop-above' : drag.over === i + 1 && i === rows.length - 1 ? 'drop-below' : '') : '';
          return (
            <div
              key={l.id}
              data-index={i}
              className={`layer-row ${l.id === doc.activeLayerId && !doc.activeGroupId ? 'active' : ''} ${l.visible ? '' : 'hidden'} ${inGroup ? 'in-group' : ''} ${dropCls}`}
              style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
              onPointerDown={(e) => {
                select(l.id);
                startDrag(e, l.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                select(l.id);
                setMenu({ x: e.clientX, y: e.clientY, layerId: l.id });
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
      {menu && <LayerMenu doc={doc} menu={menu} onClose={() => setMenu(null)} onRenameGroup={setRenamingGroup} />}
    </>
  );
}

/** Правый клик по слою или папке: цвет метки, папки. */
function LayerMenu({ doc, menu, onClose, onRenameGroup }: { doc: Doc; menu: { x: number; y: number; layerId?: string; groupId?: string }; onClose: () => void; onRenameGroup: (id: string) => void }) {
  useEffect(() => {
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest('.ctx-menu') && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const layer = menu.layerId ? doc.getLayer(menu.layerId) : null;
  const group = doc.getGroup(menu.groupId);
  const cur = layer ? layer.color ?? null : group?.color ?? null;
  const setColor = (c: LabelColor | null) => {
    if (layer) doc.setLabelColor([layer.id], c);
    else if (group) doc.updateGroup(group.id, { color: c }, 'Цвет папки');
    changed();
    onClose();
  };
  const act = (fn: () => void) => () => {
    fn();
    changed();
    onClose();
  };
  return (
    <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 260) }}>
      <div className="ctx-colors">
        <button className={`label-swatch none ${cur === null ? 'on' : ''}`} title="Без цвета" onClick={() => setColor(null)} />
        {LABEL_COLORS.map((c) => (
          <button key={c.id} className={`label-swatch ${cur === c.id ? 'on' : ''}`} style={{ background: c.css }} title={c.label} onClick={() => setColor(c.id)} />
        ))}
      </div>
      {layer && (
        <>
          <button className="ctx-item" onClick={act(() => doc.groupLayers([layer.id]))}>Новая папка из слоя</button>
          {doc.groups.filter((g) => g.id !== layer.group).map((g) => (
            <button key={g.id} className="ctx-item" onClick={act(() => doc.moveLayerToGroup(layer.id, g.id))}>В папку «{g.name}»</button>
          ))}
          {layer.group && <button className="ctx-item" onClick={act(() => doc.moveLayerToGroup(layer.id, null))}>Убрать из папки</button>}
        </>
      )}
      {group && (
        <>
          <button className="ctx-item" onClick={() => (onRenameGroup(group.id), onClose())}>Переименовать</button>
          <button className="ctx-item" onClick={act(() => doc.updateGroup(group.id, { collapsed: !group.collapsed }, 'Свернуть папку'))}>{group.collapsed ? 'Развернуть' : 'Свернуть'}</button>
          <button className="ctx-item" onClick={act(() => (doc.ungroup(group.id), (doc.activeGroupId = null)))}>Разгруппировать</button>
          <button className="ctx-item danger" onClick={act(() => (doc.removeGroupWithLayers(group.id), (doc.activeGroupId = null)))}>Удалить папку со слоями</button>
        </>
      )}
    </div>
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
      <button
        className="icon-btn"
        title="Новая папка из активного слоя (⌘G); слои перетаскиваются на заголовок папки"
        disabled={idx < 0}
        onClick={A.groupActiveLayer}
      >
        <FolderPlus size={13} />
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
