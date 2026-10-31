import { useEffect, useMemo, useRef, useState } from 'react';
import * as A from '../actions';
import { curveLut, histogram, IDENTITY_CURVES, type CurvesData } from '../core/filters';
import { activeDoc, closeDialog } from '../store';
import { requestRender } from '../tools/base';
import { Check, NumberField, Seg } from './controls';
import { Modal } from './Dialogs';

type Channel = keyof CurvesData;

const CHANNEL_COLOR: Record<Channel, string> = { rgb: '#e6e6e8', r: '#ff5050', g: '#50e050', b: '#5a8cff' };

const PRESETS: { id: string; label: string; pts: [number, number][] }[] = [
  { id: 'linear', label: 'Линейная', pts: [[0, 0], [255, 255]] },
  { id: 'contrast', label: 'Повысить контраст', pts: [[0, 0], [64, 48], [192, 208], [255, 255]] },
  { id: 'strong', label: 'Сильный контраст', pts: [[0, 0], [64, 32], [192, 224], [255, 255]] },
  { id: 'flat', label: 'Понизить контраст', pts: [[0, 24], [128, 128], [255, 232]] },
  { id: 'lighten', label: 'Осветлить', pts: [[0, 0], [128, 168], [255, 255]] },
  { id: 'darken', label: 'Затемнить', pts: [[0, 0], [128, 88], [255, 255]] },
  { id: 'invert', label: 'Негатив', pts: [[0, 255], [255, 0]] },
  { id: 'matte', label: 'Матовый (поднять чёрное)', pts: [[0, 40], [64, 72], [192, 200], [255, 245]] },
];

const SIZE = 300;

export function CurvesDialog() {
  const doc = activeDoc()!;
  const layer = doc.activeLayer!;
  const source = doc.editSource(layer);
  const [curves, setCurves] = useState<CurvesData>(() => structuredClone(IDENTITY_CURVES));
  const [channel, setChannel] = useState<Channel>('rgb');
  const [sel, setSel] = useState<number | null>(null);
  const [preview, setPreview] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hist = useMemo(() => histogram(source.getContext('2d')!.getImageData(0, 0, source.width, source.height)), [source]);
  const pts = curves[channel];

  const setPts = (next: [number, number][]) => setCurves({ ...curves, [channel]: next });

  // живой просмотр на холсте (с задержкой, чтобы перетаскивание точек было плавным)
  useEffect(() => {
    if (!preview) {
      doc.preview = null;
      requestRender();
      return;
    }
    // в фоновых потоках; устаревший результат отбрасывается
    let alive = true;
    const t = setTimeout(() => {
      void A.filterResultAsync(doc, source, 'curves', { curves }).then(({ canvas }) => {
        if (!alive) return;
        doc.preview = { layerId: layer.id, draw: (ctx) => ctx.drawImage(canvas, 0, 0) };
        requestRender();
      });
    }, 30);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [curves, preview, doc, layer, source]);
  useEffect(() => () => {
    doc.preview = null;
    requestRender();
  }, [doc]);

  // отрисовка графика
  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = SIZE * dpr;
    c.height = SIZE * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    const k = SIZE / 255;
    // гистограмма канала
    const h = channel === 'rgb' ? hist.l : hist[channel];
    const max = Math.log1p(Math.max(...h)) || 1;
    ctx.fillStyle = channel === 'rgb' ? 'rgba(255,255,255,0.12)' : CHANNEL_COLOR[channel] + '33';
    for (let i = 0; i < 256; i++) {
      const v = (Math.log1p(h[i]) / max) * SIZE * 0.9;
      ctx.fillRect(i * k, SIZE - v, k + 0.5, v);
    }
    // сетка 4×4 и диагональ
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      ctx.moveTo((SIZE * i) / 4, 0);
      ctx.lineTo((SIZE * i) / 4, SIZE);
      ctx.moveTo(0, (SIZE * i) / 4);
      ctx.lineTo(SIZE, (SIZE * i) / 4);
    }
    ctx.moveTo(0, SIZE);
    ctx.lineTo(SIZE, 0);
    ctx.stroke();
    // кривые других каналов — бледно, для ориентира
    const drawCurve = (p: [number, number][], color: string, width: number) => {
      const lut = curveLut(p);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = 0; x < 256; x++) {
        const sx = x * k, sy = SIZE - lut[x] * k;
        if (x) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      }
      ctx.stroke();
    };
    for (const ch of ['r', 'g', 'b', 'rgb'] as Channel[]) {
      if (ch === channel) continue;
      const isId = curves[ch].length === 2 && curves[ch][0][0] === 0 && curves[ch][0][1] === 0 && curves[ch][1][0] === 255 && curves[ch][1][1] === 255;
      if (!isId) drawCurve(curves[ch], CHANNEL_COLOR[ch] + '66', 1);
    }
    drawCurve(pts, CHANNEL_COLOR[channel], 2);
    pts.forEach(([x, y], i) => {
      const sx = x * k, sy = SIZE - y * k;
      ctx.fillStyle = i === sel ? CHANNEL_COLOR[channel] : '#1b1b1d';
      ctx.strokeStyle = CHANNEL_COLOR[channel];
      ctx.lineWidth = 1.5;
      ctx.fillRect(sx - 4, sy - 4, 8, 8);
      ctx.strokeRect(sx - 4, sy - 4, 8, 8);
    });
  }, [curves, channel, sel, hist, pts]);

  const toCurve = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * 255),
      y: Math.round((1 - (e.clientY - r.top) / r.height) * 255),
      outside: e.clientX < r.left - 30 || e.clientX > r.right + 30 || e.clientY < r.top - 30 || e.clientY > r.bottom + 30,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const p = toCurve(e);
    let list = [...pts].map((q) => [...q] as [number, number]);
    let idx = list.findIndex(([x, y]) => Math.abs(x - p.x) <= 6 && Math.abs(y - p.y) <= 6);
    if (idx < 0) {
      // новая точка на кривой под курсором
      const lut = curveLut(list);
      const np: [number, number] = [Math.max(0, Math.min(255, p.x)), lut[Math.max(0, Math.min(255, p.x))]];
      list.push(np);
      list.sort((a, b) => a[0] - b[0]);
      idx = list.indexOf(np);
      setPts(list);
    }
    setSel(idx);
    el.setPointerCapture(e.pointerId);
    let removed = false;
    const move = (ev: PointerEvent) => {
      const q = toCurve(ev);
      const isEnd = idx === 0 || idx === list.length - 1;
      if (q.outside && !isEnd && list.length > 2) {
        removed = true;
        setPts(list.filter((_, i) => i !== idx));
        return;
      }
      removed = false;
      // точка не может перейти через соседей
      const lo = idx > 0 ? list[idx - 1][0] + 1 : 0;
      const hi = idx < list.length - 1 ? list[idx + 1][0] - 1 : 255;
      const next = list.map((v) => [...v] as [number, number]);
      next[idx] = [Math.max(lo, Math.min(hi, q.x)), Math.max(0, Math.min(255, q.y))];
      list = next;
      setPts(next);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (removed) setSel(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onDouble = (e: React.MouseEvent) => {
    const p = toCurve(e);
    const idx = pts.findIndex(([x, y]) => Math.abs(x - p.x) <= 6 && Math.abs(y - p.y) <= 6);
    if (idx > 0 && idx < pts.length - 1) {
      setPts(pts.filter((_, i) => i !== idx));
      setSel(null);
    }
  };

  const ok = () => {
    doc.preview = null;
    A.applyFilter('curves', { curves });
    closeDialog();
  };

  const cur = sel !== null ? pts[sel] : null;
  return (
    <Modal
      seeThrough
      title="Кривые"
      onClose={closeDialog}
      width={560}
      footer={
        <>
          <span className="left"><Check label="Просмотр" checked={preview} onChange={setPreview} /></span>
          <button className="btn" onClick={() => { setCurves(structuredClone(IDENTITY_CURVES)); setSel(null); }}>Сбросить всё</button>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn primary" onClick={ok}>OK</button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Seg
            value={channel}
            onChange={(c) => { setChannel(c); setSel(null); }}
            options={[{ id: 'rgb', label: 'RGB' }, { id: 'r', label: 'Красный' }, { id: 'g', label: 'Зелёный' }, { id: 'b', label: 'Синий' }]}
          />
          <div className="curves-box" onPointerDown={onDown} onDoubleClick={onDouble}>
            <canvas ref={canvasRef} />
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <NumberField label="Вход" value={cur?.[0] ?? 0} min={0} max={255} width={46} onChange={(v) => {
              if (sel === null) return;
              const next = pts.map((q) => [...q] as [number, number]);
              const lo = sel > 0 ? next[sel - 1][0] + 1 : 0, hi = sel < next.length - 1 ? next[sel + 1][0] - 1 : 255;
              next[sel][0] = Math.max(lo, Math.min(hi, Math.round(v)));
              setPts(next);
            }} />
            <NumberField label="Выход" value={cur?.[1] ?? 0} min={0} max={255} width={46} onChange={(v) => {
              if (sel === null) return;
              const next = pts.map((q) => [...q] as [number, number]);
              next[sel][1] = Math.round(v);
              setPts(next);
            }} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
          <span className="note">Пресеты для канала «{channel === 'rgb' ? 'RGB' : channel.toUpperCase()}»:</span>
          {PRESETS.map((p) => (
            <button key={p.id} className="btn" style={{ textAlign: 'left' }} onClick={() => { setPts(p.pts.map((q) => [...q] as [number, number])); setSel(null); }}>
              {p.label}
            </button>
          ))}
          <span className="note" style={{ marginTop: 6 }}>
            Клик по кривой — новая точка, перетаскивание — изменить, двойной клик или увести за край — удалить.
          </span>
        </div>
      </div>
    </Modal>
  );
}
