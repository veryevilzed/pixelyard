import { useEffect, useMemo, useRef, useState } from 'react';
import { cropCanvas, ctx2d, scaleCanvas } from '../core/canvas';
import { maskedCopy } from '../core/selection';
import { fileStem } from '../core/io';
import { encodePdf } from '../core/pdf';
import { DEFAULT_PRINT, drawPrintPage, effectivePpi, fitWidth, imageRect, MM_PER_INCH, PAPERS, paperSize, renderPrintPage, type PrintSettings } from '../core/print';
import { printPages, saveFileAs } from '../core/platform';
import { activeDoc, closeDialog, toast, useApp } from '../store';
import { Check, NumberField, Seg } from './controls';
import { Modal } from './Dialogs';

const KEY = 'pixelyard.print';

/**
 * Печать как в Photoshop: лист с полями, картинку можно двигать мышью, масштабировать колёсиком
 * и за углы, подогнать под лист; метки обреза и приводки; печать через системный диалог или PDF.
 */
export function PrintDialog() {
  const doc = activeDoc()!;
  const [what, setWhat] = useState<'image' | 'selection'>(doc.selection ? 'selection' : 'image');
  // что печатаем: сведённое изображение или выделенная область
  const source = useMemo(() => {
    const flat = doc.composite();
    if (what === 'selection' && doc.selection) return cropCanvas(maskedCopy(flat, doc.selection), doc.selection.bounds);
    return flat;
  }, [doc, what]);
  const small = useMemo(() => {
    const k = Math.min(1, 1400 / Math.max(source.width, source.height));
    return k < 1 ? scaleCanvas(source, Math.round(source.width * k), Math.round(source.height * k), true) : source;
  }, [source]);
  const [s, setS] = useState<PrintSettings>(() => {
    const saved = { ...DEFAULT_PRINT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } as PrintSettings;
    saved.marks = { ...DEFAULT_PRINT.marks, ...saved.marks };
    // новая картинка — сразу подогнать под лист
    return { ...saved, center: true, width: fitWidth(saved, source.width, source.height, 'fit') };
  });
  const set = (p: Partial<PrintSettings>) => setS((o) => ({ ...o, ...p }));
  const P = paperSize(s);
  const r = imageRect(s, source.width, source.height);
  const ppi = effectivePpi(s, source.width);

  // ---------- предпросмотр ----------
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 520, h: 560 });
  useEffect(() => {
    const el = boxRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** Пикселей экрана на мм и положение листа в превью. */
  const view = useMemo(() => {
    const k = Math.min((box.w - 40) / P.w, (box.h - 40) / P.h);
    return { k, ox: (box.w - P.w * k) / 2, oy: (box.h - P.h * k) / 2 };
  }, [box, P.w, P.h]);

  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = box.w * dpr;
    c.height = box.h * dpr;
    const ctx = ctx2d(c);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    const { k, ox, oy } = view;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(ox + 4, oy + 4, P.w * k, P.h * k);
    ctx.save();
    ctx.translate(ox, oy);
    drawPrintPage(ctx, small, s, k, { name: doc.name, w: source.width, h: source.height });
    // поля (не печатаются)
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(59,130,246,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(s.margin * k + 0.5, s.margin * k + 0.5, (P.w - 2 * s.margin) * k, (P.h - 2 * s.margin) * k);
    ctx.setLineDash([]);
    // рамка картинки и ручки
    const ir = imageRect(s, source.width, source.height);
    ctx.strokeStyle = '#3b82f6';
    ctx.strokeRect(ir.x * k + 0.5, ir.y * k + 0.5, ir.w * k, ir.h * k);
    ctx.fillStyle = '#fff';
    for (const [hx, hy] of corners(ir)) {
      ctx.fillRect(hx * k - 4, hy * k - 4, 8, 8);
      ctx.strokeRect(hx * k - 4 + 0.5, hy * k - 4 + 0.5, 8, 8);
    }
    // за пределами листа — предупреждение
    if (ir.x < 0 || ir.y < 0 || ir.x + ir.w > P.w || ir.y + ir.h > P.h) {
      ctx.fillStyle = 'rgba(239,68,68,0.9)';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText('Картинка выходит за лист — края обрежутся', 6, P.h * k - 8);
    }
    ctx.restore();
  }, [s, view, box, small, source, doc.name, P.w, P.h]);

  const toMm = (e: { clientX: number; clientY: number }) => {
    const rc = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rc.left - view.ox) / view.k, y: (e.clientY - rc.top - view.oy) / view.k };
  };

  const onDown = (e: React.PointerEvent) => {
    const p = toMm(e);
    const ir = imageRect(s, source.width, source.height);
    const tol = 8 / view.k;
    const ci = corners(ir).findIndex(([x, y]) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol);
    const inside = p.x >= ir.x && p.y >= ir.y && p.x <= ir.x + ir.w && p.y <= ir.y + ir.h;
    if (ci < 0 && !inside) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const start = p, base = ir, ratio = source.height / source.width;
    const move = (ev: PointerEvent) => {
      const q = toMm(ev);
      if (ci < 0) return set({ center: false, x: round1(base.x + q.x - start.x), y: round1(base.y + q.y - start.y) });
      // угол: противоположный угол на месте, пропорции сохраняются
      const [ax, ay] = corners(base)[3 - ci];
      const w = Math.max(5, Math.abs(q.x - ax), Math.abs(q.y - ay) / ratio);
      const h = w * ratio;
      set({ center: false, width: round1(w), x: round1(q.x < ax ? ax - w : ax), y: round1(q.y < ay ? ay - h : ay) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // колёсико — масштаб вокруг курсора
  useEffect(() => {
    const c = canvasRef.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setS((o) => {
        const p = toMm(e);
        const ir = imageRect(o, source.width, source.height);
        const f = Math.exp(-e.deltaY * 0.0025);
        const w = Math.max(5, Math.min(5000, ir.w * f));
        const k = w / ir.w;
        return { ...o, center: false, width: round1(w), x: round1(p.x - (p.x - ir.x) * k), y: round1(p.y - (p.y - ir.y) * k) };
      });
    };
    c.addEventListener('wheel', wheel, { passive: false });
    return () => c.removeEventListener('wheel', wheel);
  });

  // ---------- действия ----------
  const fit = (mode: 'fit' | 'fill' | 'actual') => set({ center: true, width: round1(fitWidth(s, source.width, source.height, mode)) });
  const remember = () => localStorage.setItem(KEY, JSON.stringify({ ...s, x: undefined, y: undefined, width: undefined }));
  const name = fileStem(doc.name);

  const doPrint = async () => {
    remember();
    useApp.setState({ busy: 'Подготовка к печати…' });
    try {
      const page = renderPrintPage(source, s, doc.name);
      useApp.setState({ busy: null });
      await printPages([page], P);
      closeDialog();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      useApp.setState({ busy: null });
    }
  };
  const doPdf = async () => {
    remember();
    useApp.setState({ busy: 'Сборка PDF…' });
    try {
      const page = renderPrintPage(source, s, doc.name);
      const data = encodePdf([page], s.dpi, name);
      useApp.setState({ busy: null });
      const path = await saveFileAs(`${name}.pdf`, data, [{ name: 'PDF', extensions: ['pdf'] }]);
      if (path) {
        toast('PDF листа сохранён');
        closeDialog();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      useApp.setState({ busy: null });
    }
  };

  const mark = (k: keyof PrintSettings['marks']) => ({ checked: s.marks[k], onChange: (v: boolean) => set({ marks: { ...s.marks, [k]: v } }) });

  return (
    <Modal
      title="Печать"
      onClose={closeDialog}
      width={1000}
      footer={
        <>
          <span className="left note">
            {r.w.toFixed(1)} × {r.h.toFixed(1)} мм · {Math.round(ppi)} ppi{ppi < 150 ? ' — для печати мало, будет мягко' : ''}
          </span>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn" onClick={() => void doPdf()}>Сохранить PDF…</button>
          <button className="btn primary" onClick={() => void doPrint()}>Печать…</button>
        </>
      }
    >
      <div className="print-layout">
        <div className="print-preview" ref={boxRef}>
          <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} onPointerDown={onDown} />
        </div>
        <div className="pack-settings print-settings">
          <div className="section-title">Лист</div>
          <div className="row-fields">
            <select value={s.paper} onChange={(e) => set({ paper: e.target.value })} style={{ flex: 1 }}>
              {PAPERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          {s.paper === 'custom' && (
            <div className="row-fields">
              <NumberField label="Ш" value={s.customW} min={20} max={2000} step={0.1} width={56} onChange={(v) => set({ customW: v })} suffix="мм" />
              <NumberField label="В" value={s.customH} min={20} max={2000} step={0.1} width={56} onChange={(v) => set({ customH: v })} suffix="мм" />
            </div>
          )}
          <div className="row-fields">
            <Seg value={s.landscape ? 'l' : 'p'} onChange={(v) => set({ landscape: v === 'l' })} options={[{ id: 'p', label: 'Книжная' }, { id: 'l', label: 'Альбомная' }]} />
            <NumberField label="Поля" value={s.margin} min={0} max={50} step={0.5} width={40} onChange={(v) => set({ margin: v })} suffix="мм" />
          </div>
          {doc.selection && (
            <>
              <div className="section-title">Что печатать</div>
              <Seg value={what} onChange={setWhat} options={[{ id: 'image', label: 'Изображение' }, { id: 'selection', label: 'Выделенную область' }]} />
            </>
          )}
          <div className="section-title">Положение и размер</div>
          <div className="row-fields" style={{ flexWrap: 'wrap' }}>
            <button className="btn small" onClick={() => fit('fit')} title="Целиком внутри полей">Подогнать под лист</button>
            <button className="btn small" onClick={() => fit('fill')} title="Заполнить поля, лишнее обрежется">Заполнить</button>
            <button className="btn small" onClick={() => fit('actual')} title={`Размер по разрешению ${s.ppi} ppi`}>100%</button>
          </div>
          <Check label="По центру" checked={s.center} onChange={(center) => set({ center, x: round1(r.x), y: round1(r.y) })} />
          <div className="row-fields">
            <NumberField label="X" value={round1(r.x)} step={0.5} width={50} onChange={(x) => set({ center: false, x, y: round1(r.y) })} suffix="мм" />
            <NumberField label="Y" value={round1(r.y)} step={0.5} width={50} onChange={(y) => set({ center: false, y, x: round1(r.x) })} suffix="мм" />
          </div>
          <div className="row-fields">
            <NumberField label="Ш" value={round1(r.w)} min={5} max={5000} step={0.5} width={50} onChange={(width) => set({ width })} suffix="мм" />
            <NumberField label="В" value={round1(r.h)} min={5} max={5000} step={0.5} width={50} onChange={(h) => set({ width: round1((h * source.width) / source.height) })} suffix="мм" />
          </div>
          <div className="row-fields">
            <NumberField
              label="Масштаб"
              value={Math.round((r.w / ((source.width / s.ppi) * MM_PER_INCH)) * 1000) / 10}
              min={1}
              max={10000}
              step={1}
              width={50}
              onChange={(v) => set({ width: round1(((source.width / s.ppi) * MM_PER_INCH * v) / 100) })}
              suffix="%"
            />
            <NumberField label="при" value={s.ppi} min={10} max={2400} width={44} onChange={(ppi) => set({ ppi })} suffix="ppi" title="Разрешение изображения для 100%" />
          </div>
          <div className="note">Картинку на листе можно двигать мышью, масштабировать колёсиком и за углы.</div>
          <div className="section-title">Метки печати</div>
          <Check label="Угловые метки обреза" {...mark('corner')} />
          <Check label="Центральные метки обреза" {...mark('center')} />
          <Check label="Метки приводки" {...mark('registration')} />
          <Check label="Описание (файл, размер, разрешение, дата)" {...mark('description')} />
          <Check label="Рамка по краю картинки" {...mark('border')} />
          <div className="row-fields">
            <NumberField label="Выпуск под обрез" value={s.bleed} min={0} max={20} step={0.5} width={40} onChange={(bleed) => set({ bleed })} suffix="мм" title="Метки отодвигаются от края картинки" />
          </div>
          <div className="section-title">Качество</div>
          <div className="row-fields">
            <span className="label static">Разрешение листа</span>
            <select value={s.dpi} onChange={(e) => set({ dpi: Number(e.target.value) })}>
              {[150, 300, 600].map((d) => (
                <option key={d} value={d}>{d} dpi</option>
              ))}
            </select>
          </div>
          <div className="note">В системном диалоге печати выберите тот же размер бумаги ({P.w.toFixed(0)} × {P.h.toFixed(0)} мм) и масштаб 100%.</div>
        </div>
      </div>
    </Modal>
  );
}

const round1 = (v: number) => Math.round(v * 10) / 10;
/** Углы: 0 — левый верхний, 1 — правый верхний, 2 — левый нижний, 3 — правый нижний (противоположный = 3 − i). */
const corners = (r: { x: number; y: number; w: number; h: number }): [number, number][] => [
  [r.x, r.y],
  [r.x + r.w, r.y],
  [r.x, r.y + r.h],
  [r.x + r.w, r.y + r.h],
];
