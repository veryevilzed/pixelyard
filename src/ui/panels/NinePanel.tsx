import { useEffect, useRef, useState } from 'react';
import { ctx2d } from '../../core/canvas';
import { writeFiles } from '../../core/export';
import { encodeCanvas, fileStem } from '../../core/io';
import { clampNine, drawNine, encodeNinePatchCanvas, renderNine, type NineMode } from '../../core/nineslice';
import { lastComposite } from '../../core/render';
import type { NineSlice } from '../../core/types';
import { activeDoc, toast, useApp } from '../../store';
import { changed, onRenderRequest } from '../../tools/base';
import { Check, NumberField, Seg } from '../controls';

/** Размер предпросмотра на документ (вне истории). */
const previewSize = new WeakMap<object, { w: number; h: number }>();

/**
 * Редактор 9-slice: границы задаются полями или перетаскиванием линий на холсте, предпросмотр
 * показывает растянутую картинку вживую (в том числе во время рисования).
 */
export function NinePanel() {
  useApp((s) => s.tick);
  const doc = activeDoc();
  const [mode, setMode] = useState<NineMode>('stretch');
  const [smooth, setSmooth] = useState(true);
  const [, force] = useState(0);
  const ref = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const size = doc ? previewSize.get(doc) ?? { w: Math.round(doc.width * 2), h: Math.round(doc.height * 1.5) } : { w: 0, h: 0 };
  const setSize = (s: { w: number; h: number }) => {
    if (!doc) return;
    previewSize.set(doc, { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) });
    force((x) => x + 1);
  };

  // перерисовка при любой перерисовке холста — превью видно прямо во время мазка
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = 0;
      const c = ref.current, d = activeDoc(), box = boxRef.current;
      if (!c || !d?.nine || !box) return;
      const src = lastComposite(d) ?? d.composite();
      const sz = previewSize.get(d) ?? { w: Math.round(d.width * 2), h: Math.round(d.height * 1.5) };
      const maxW = Math.max(60, box.clientWidth - 16);
      const k = Math.min(1, maxW / sz.w, 260 / sz.h);
      const dpr = window.devicePixelRatio || 1;
      c.style.width = `${sz.w * k}px`;
      c.style.height = `${sz.h * k}px`;
      c.width = Math.max(1, Math.round(sz.w * k * dpr));
      c.height = Math.max(1, Math.round(sz.h * k * dpr));
      const ctx = ctx2d(c);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.imageSmoothingEnabled = smooth;
      // рисуем в полном размере и масштабируем — так углы выглядят как в игре
      ctx.save();
      ctx.scale(k * dpr, k * dpr);
      drawNine(ctx, src, d.nine, 0, 0, sz.w, sz.h, mode);
      ctx.restore();
    };
    const schedule = () => {
      // после отрисовки холста (там пересчитывается сведение)
      if (!raf) raf = requestAnimationFrame(() => (raf = requestAnimationFrame(draw)));
    };
    schedule();
    const off = onRenderRequest(schedule);
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  });

  if (!doc) return <div className="panel-body note">Нет документа</div>;
  const n = doc.nine;
  if (!n)
    return (
      <div className="panel-body">
        <div className="note">Рисуйте картинку как обычно — здесь будет видно, как она тянется в игре. Углы не масштабируются, края и центр тянутся.</div>
        <button
          className="btn"
          onClick={() => {
            const d = Math.max(1, Math.floor(Math.min(doc.width, doc.height) / 4));
            doc.setNine({ left: d, top: d, right: d, bottom: d }, 'Включить 9-slice');
            changed();
          }}
        >
          Включить 9-slice
        </button>
      </div>
    );

  const upd = (patch: Partial<NineSlice>) => {
    const last = doc.undoStack[doc.undoStack.length - 1];
    if (last?.label === 'Границы 9-slice' && last.after?.nine === doc.nine) doc.undo();
    doc.setNine(clampNine({ ...n, ...patch }, doc.width, doc.height), 'Границы 9-slice');
    changed();
  };

  const resize = (e: React.PointerEvent) => {
    const c = ref.current!;
    const k = c.clientWidth / size.w;
    const sx = e.clientX, sy = e.clientY, s0 = size;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSize({ w: Math.max(n.left + n.right, s0.w + (ev.clientX - sx) / k), h: Math.max(n.top + n.bottom, s0.h + (ev.clientY - sy) / k) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const save = async (kind: 'patch' | 'json' | 'stretched') => {
    const src = doc.composite();
    const name = fileStem(doc.name);
    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = {};
    if (kind === 'patch') files[`${name}.9.png`] = await encodeCanvas(encodeNinePatchCanvas(src, n), 'png');
    if (kind === 'json') {
      files[`${name}.png`] = await encodeCanvas(src, 'png');
      files[`${name}.json`] = enc.encode(JSON.stringify({ image: `${name}.png`, width: doc.width, height: doc.height, ...n }, null, 2));
    }
    if (kind === 'stretched') files[`${name}_${size.w}x${size.h}.png`] = await encodeCanvas(renderNine(src, n, size.w, size.h, mode, smooth), 'png');
    try {
      const res = await writeFiles(files, name, false);
      if (res) toast(`Сохранено: ${Object.keys(files).join(', ')}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <div className="slice-edit nine-panel" ref={boxRef}>
      <NumberField label="Л" value={n.left} min={0} max={doc.width} width={40} onChange={(v) => upd({ left: v })} />
      <NumberField label="В" value={n.top} min={0} max={doc.height} width={40} onChange={(v) => upd({ top: v })} />
      <NumberField label="П" value={n.right} min={0} max={doc.width} width={40} onChange={(v) => upd({ right: v })} />
      <NumberField label="Н" value={n.bottom} min={0} max={doc.height} width={40} onChange={(v) => upd({ bottom: v })} />
      <div className="full note">Линии на холсте двигаются мышью (с кистью — с ⌘).</div>
      <div className="full row-fields">
        <NumberField label="Ш" value={size.w} min={1} max={8192} width={48} onChange={(w) => setSize({ ...size, w })} suffix="px" />
        <NumberField label="В" value={size.h} min={1} max={8192} width={48} onChange={(h) => setSize({ ...size, h })} suffix="px" />
      </div>
      <div className="full row-fields">
        <Seg value={mode} onChange={setMode} options={[{ id: 'stretch', label: 'Тянуть' }, { id: 'tile', label: 'Повторять' }]} />
        <Check label="Сглаживание" checked={smooth} onChange={setSmooth} />
      </div>
      <div className="full row-fields">
        {[
          ['×2', doc.width * 2, doc.height * 2],
          ['Широкая', doc.width * 3, doc.height],
          ['Высокая', doc.width, doc.height * 3],
          ['Узкая', n.left + n.right + 2, doc.height],
        ].map(([l, w, h]) => (
          <button key={String(l)} className="btn small" onClick={() => setSize({ w: Number(w), h: Number(h) })}>{l}</button>
        ))}
      </div>
      <div className="full nine-preview">
        <div className="nine-preview-box">
          <canvas ref={ref} />
          <span className="nine-handle" onPointerDown={resize} title="Потяните, чтобы изменить размер" />
        </div>
      </div>
      <div className="full row-fields" style={{ flexWrap: 'wrap' }}>
        <button className="btn small" onClick={() => void save('patch')} title="Картинка в рамке 1 px с чёрными метками — формат Android">Android .9.png</button>
        <button className="btn small" onClick={() => void save('json')}>PNG + JSON</button>
        <button className="btn small" onClick={() => void save('stretched')}>Растянутая {size.w}×{size.h}</button>
        <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => (doc.setNine(null, 'Выключить 9-slice'), changed())}>Выключить</button>
      </div>
    </div>
  );
}
