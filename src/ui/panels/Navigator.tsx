import { Crosshair, Maximize2, Minimize2, MoveHorizontal, MoveVertical, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { centerView, fitMode, zoomBy, zoomTo } from '../../actions';
import { ctx2d } from '../../core/canvas';
import { lastComposite, zoomAt } from '../../core/render';
import { sizeForDoc } from '../../panes';
import { activeDoc, useApp } from '../../store';
import { changed, onRenderRequest } from '../../tools/base';
import { NumberField } from '../controls';

const PAD = 6;

/** Где миниатюра документа лежит внутри навигатора (CSS-пиксели). */
function layout(docW: number, docH: number, w: number, h: number) {
  const k = Math.min((w - PAD * 2) / docW, (h - PAD * 2) / docH);
  const tw = docW * k, th = docH * k;
  return { k, x: (w - tw) / 2, y: (h - th) / 2, w: tw, h: th };
}

/**
 * Навигатор: миниатюра активного документа и рамка видимой части.
 * Клик/перетаскивание переносит туда вид — удобно при сильном увеличении.
 */
export function Navigator() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useApp((s) => s.tick);
  const doc = activeDoc();

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    let frame = 0;
    let lastThumb = 0;
    const draw = () => {
      frame = 0;
      const d = activeDoc();
      const dpr = window.devicePixelRatio || 1;
      const r = wrap.getBoundingClientRect();
      if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
        canvas.width = Math.round(r.width * dpr);
        canvas.height = Math.round(r.height * dpr);
      }
      const ctx = ctx2d(canvas);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);
      if (!d) return;
      const L = layout(d.width, d.height, r.width, r.height);
      // шахматка под прозрачным
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(L.x, L.y, L.w, L.h);
      ctx.fillStyle = '#2e2e2e';
      for (let y = 0; y < L.h; y += 6)
        for (let x = (Math.floor(y / 6) % 2) * 6; x < L.w; x += 12) ctx.fillRect(L.x + x, L.y + y, Math.min(6, L.w - x), Math.min(6, L.h - y));
      const comp = lastComposite(d);
      if (comp) {
        ctx.imageSmoothingEnabled = L.k < 1;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(comp, L.x, L.y, L.w, L.h);
      }
      lastThumb = performance.now();
      // видимая область документа
      const vs = sizeForDoc(d.id);
      const v = d.view;
      const vx = -v.panX / v.zoom, vy = -v.panY / v.zoom;
      const vw = vs.w / v.zoom, vh = vs.h / v.zoom;
      const rx = L.x + vx * L.k, ry = L.y + vy * L.k, rw = vw * L.k, rh = vh * L.k;
      const covers = vx <= 0 && vy <= 0 && vx + vw >= d.width && vy + vh >= d.height;
      ctx.save();
      if (!covers) {
        // затемняем то, что вне экрана
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath();
        ctx.rect(L.x, L.y, L.w, L.h);
        ctx.rect(rx, ry, rw, rh);
        ctx.fill('evenodd');
      }
      ctx.beginPath();
      ctx.rect(L.x - 1, L.y - 1, L.w + 2, L.h + 2);
      ctx.clip();
      ctx.strokeStyle = '#ff3b3b';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5, Math.max(2, Math.round(rw) - 1), Math.max(2, Math.round(rh) - 1));
      ctx.restore();
    };
    const schedule = () => {
      if (frame) return;
      // миниатюра обновляется не чаще ~15 раз в секунду, чтобы не мешать рисованию
      const wait = Math.max(0, 66 - (performance.now() - lastThumb));
      frame = window.setTimeout(() => requestAnimationFrame(draw), wait);
    };
    const off = onRenderRequest(schedule);
    const unsub = useApp.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(wrap);
    schedule();
    return () => {
      off();
      unsub();
      ro.disconnect();
      clearTimeout(frame);
    };
  }, []);

  const centerOn = (e: React.PointerEvent | PointerEvent) => {
    const d = activeDoc();
    if (!d) return;
    const r = wrapRef.current!.getBoundingClientRect();
    const L = layout(d.width, d.height, r.width, r.height);
    const px = (e.clientX - r.left - L.x) / L.k, py = (e.clientY - r.top - L.y) / L.k;
    const vs = sizeForDoc(d.id);
    d.view = { ...d.view, panX: vs.w / 2 - px * d.view.zoom, panY: vs.h / 2 - py * d.view.zoom };
    changed();
  };

  const zoom = doc?.view.zoom ?? 1;
  // ползунок в логарифмической шкале: 2% … 6400%
  const toSlider = (z: number) => Math.log2(z);
  const fromSlider = (v: number) => Math.pow(2, v);
  return (
    <div className="panel-body">
      <div
        className="navigator"
        ref={wrapRef}
        onPointerDown={(e) => {
          if (!doc) return;
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          centerOn(e);
          const move = (ev: PointerEvent) => centerOn(ev);
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
        }}
        onWheel={(e) => {
          const d = activeDoc();
          if (!d) return;
          const vs = sizeForDoc(d.id);
          d.view = zoomAt(d.view, d.view.zoom * Math.exp(-e.deltaY * 0.005), vs.w / 2, vs.h / 2);
          changed();
        }}
      >
        <canvas ref={canvasRef} />
      </div>
      <div className="nav-zoom">
        <button className="icon-btn" title="Уменьшить (⌘−)" disabled={!doc} onClick={() => zoomBy(-1)}>
          <ZoomOut size={13} />
        </button>
        <input
          type="range"
          min={toSlider(0.02)}
          max={toSlider(64)}
          step={0.01}
          value={toSlider(zoom)}
          disabled={!doc}
          onChange={(e) => {
            const d = activeDoc();
            if (!d) return;
            const vs = sizeForDoc(d.id);
            d.view = zoomAt(d.view, fromSlider(Number(e.target.value)), vs.w / 2, vs.h / 2);
            changed();
          }}
        />
        <button className="icon-btn" title="Увеличить (⌘+)" disabled={!doc} onClick={() => zoomBy(1)}>
          <ZoomIn size={13} />
        </button>
        <NumberField value={Math.round(zoom * 1000) / 10} min={2} max={6400} width={56} suffix="%" onChange={(v) => zoomTo(v / 100)} />
      </div>
      <div className="nav-buttons">
        <button className="btn" title="Центрировать, не меняя масштаб (⇧⌘0)" disabled={!doc} onClick={centerView}>
          <Crosshair size={12} /> Центр
        </button>
        <button className="btn" title="Вписать в экран целиком (⌘0)" disabled={!doc} onClick={() => fitMode('fit')}>
          <Minimize2 size={12} /> Вписать
        </button>
        <button className="btn" title="Заполнить экран (по большей стороне)" disabled={!doc} onClick={() => fitMode('fill')}>
          <Maximize2 size={12} /> Заполнить
        </button>
        <button className="btn" title="Вписать по ширине" disabled={!doc} onClick={() => fitMode('width')}>
          <MoveHorizontal size={12} /> По ширине
        </button>
        <button className="btn" title="Вписать по высоте" disabled={!doc} onClick={() => fitMode('height')}>
          <MoveVertical size={12} /> По высоте
        </button>
        <button className="btn" title="Реальный размер, 100% (⌘1)" disabled={!doc} onClick={() => zoomTo(1)}>
          1:1
        </button>
        <button className="btn" title="200% (⌘2)" disabled={!doc} onClick={() => zoomTo(2)}>
          2:1
        </button>
      </div>
    </div>
  );
}
