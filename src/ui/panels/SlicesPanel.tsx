import { Download, Grid3x3, ScanLine, Trash } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { activeDoc, openDialog, useApp } from '../../store';
import { changed } from '../../tools/base';
import type { Slice } from '../../core/types';
import { Check, NumberField, TextInput , scrollIntoList } from '../controls';

export function SlicesPanel() {
  useApp((s) => s.tick);
  const doc = activeDoc();
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollIntoList(activeRef.current);
  }, [doc?.activeSliceId]);
  if (!doc) return <div className="panel-body note">Нет документа</div>;
  const active = doc.slices.find((s) => s.id === doc.activeSliceId);
  const upd = (patch: Partial<Slice>, label?: string) => {
    if (!active) return;
    // ввод имени по буквам схлопывается в одну запись истории
    const last = doc.undoStack[doc.undoStack.length - 1];
    if (label === 'Переименовать слайс' && last?.label === label && last.after?.slices === doc.slices) doc.undo();
    doc.updateSlice(active.id, patch, label);
    changed();
  };
  return (
    <>
      {active && (
        <div className="slice-edit">
          <div className="full">
            <TextInput value={active.name} onChange={(v) => upd({ name: v }, 'Переименовать слайс')} width="100%" />
          </div>
          <NumberField label="X" value={active.x} min={0} max={doc.width - 1} width={44} onChange={(v) => upd({ x: Math.round(v) })} />
          <NumberField label="Y" value={active.y} min={0} max={doc.height - 1} width={44} onChange={(v) => upd({ y: Math.round(v) })} />
          <NumberField label="Ш" value={active.w} min={1} max={doc.width} width={44} onChange={(v) => upd({ w: Math.round(v) })} />
          <NumberField label="В" value={active.h} min={1} max={doc.height} width={44} onChange={(v) => upd({ h: Math.round(v) })} />
          <div className="full">
            <Check
              label="9-slice (растягиваемые границы)"
              checked={!!active.nine}
              onChange={(v) => {
                const d = Math.max(1, Math.floor(Math.min(active.w, active.h) / 4));
                upd({ nine: v ? { left: d, top: d, right: d, bottom: d } : null }, '9-slice');
              }}
            />
          </div>
          {active.nine && (
            <>
              <NumberField label="Л" value={active.nine.left} min={0} max={active.w} width={44} onChange={(v) => upd({ nine: { ...active.nine!, left: Math.round(v) } }, '9-slice')} />
              <NumberField label="В" value={active.nine.top} min={0} max={active.h} width={44} onChange={(v) => upd({ nine: { ...active.nine!, top: Math.round(v) } }, '9-slice')} />
              <NumberField label="П" value={active.nine.right} min={0} max={active.w} width={44} onChange={(v) => upd({ nine: { ...active.nine!, right: Math.round(v) } }, '9-slice')} />
              <NumberField label="Н" value={active.nine.bottom} min={0} max={active.h} width={44} onChange={(v) => upd({ nine: { ...active.nine!, bottom: Math.round(v) } }, '9-slice')} />
            </>
          )}
        </div>
      )}
      <div className="panel-body list" style={{ maxHeight: 220 }}>
        {doc.slices.length === 0 && (
          <div className="note" style={{ padding: 8 }}>
            Слайсов нет. Инструмент «Раскройка» (K), меню «Нарезка» или кнопки выше.
          </div>
        )}
        {doc.slices.map((s) => (
          <div
            key={s.id}
            ref={s.id === doc.activeSliceId ? activeRef : undefined}
            className={`slice-row ${s.id === doc.activeSliceId ? 'active' : ''}`}
            onClick={() => {
              doc.activeSliceId = s.id;
              changed();
            }}
          >
            <span>{s.name}</span>
            {s.nine && <span className="note">9s</span>}
            <span className="dim">
              {s.w}×{s.h}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export function SlicesActions() {
  useApp((s) => s.tick);
  const doc = activeDoc();
  return (
    <>
      <button className="icon-btn" title="Нарезать сеткой" disabled={!doc} onClick={() => openDialog({ kind: 'grid-slice' })}>
        <Grid3x3 size={13} />
      </button>
      <button className="icon-btn" title="Авто-нарезка по прозрачности" disabled={!doc} onClick={() => openDialog({ kind: 'auto-slice' })}>
        <ScanLine size={13} />
      </button>
      <button
        className="icon-btn"
        title="Удалить выбранный слайс"
        disabled={!doc?.activeSliceId}
        onClick={() => {
          if (!doc) return;
          doc.setSlices(doc.slices.filter((s) => s.id !== doc.activeSliceId), 'Удалить слайс');
          doc.activeSliceId = null;
          changed();
        }}
      >
        <Trash size={13} />
      </button>
      <button className="icon-btn" title="Экспорт слайсов" disabled={!doc?.slices.length} onClick={() => openDialog({ kind: 'export', source: 'slices' })}>
        <Download size={13} />
      </button>
    </>
  );
}
