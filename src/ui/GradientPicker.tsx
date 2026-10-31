import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { rgbaToCss } from '../core/canvas';
import { GRADIENT_PRESETS, gradientCss, loadUserGradients, resolveStops, sampleStops, saveUserGradients, type GradientDef, type GradStop } from '../core/gradient';
import type { RGBA } from '../core/types';
import { setOpts, useApp } from '../store';
import { ColorField, NumberField } from './controls';

/**
 * Выбор и правка градиента (как в Photoshop): полоска-превью в панели параметров, по клику —
 * наборы (готовые и свои) и редактор: клик по полосе — новая точка, перетаскивание — сдвиг,
 * утащить вниз — удалить; у выбранной точки — цвет (свой, основной или фоновый), непрозрачность, позиция.
 */

const CHECKER = 'repeating-conic-gradient(#777 0 25%, #555 0 50%) 0 0 / 10px 10px';

function Strip({ stops, height = 18, onClick }: { stops: GradStop[]; height?: number; onClick?: () => void }) {
  const fg = useApp((s) => s.fg);
  const bg = useApp((s) => s.bg);
  return (
    <span className="grad-strip" style={{ height, background: `${gradientCss(resolveStops(stops, fg, bg))}, ${CHECKER}` }} onClick={onClick} />
  );
}

export function GradientPicker() {
  const stops = useApp((s) => s.opts.gradientStops);
  const fg = useApp((s) => s.fg);
  const bg = useApp((s) => s.bg);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [user, setUser] = useState<GradientDef[]>(loadUserGradients);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - 384)), top: r.bottom + 4 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const set = (next: GradStop[]) => setOpts({ gradientStops: next });
  const cur = stops[Math.min(sel, stops.length - 1)];
  const sorted = resolveStops(stops, fg, bg);

  /** Перетаскивание точки; вниз от полосы больше чем на 40 px — удалить (если точек больше двух). */
  const dragStop = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(i);
    const r = bar.current!.getBoundingClientRect();
    let list = stops;
    const move = (ev: PointerEvent) => {
      const remove = ev.clientY - r.bottom > 40 && stops.length > 2;
      const p = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      list = remove ? stops.filter((_, k) => k !== i) : stops.map((st, k) => (k === i ? { ...st, pos: Math.round(p * 1000) / 1000 } : st));
      set(list);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (list.length < stops.length) setSel(0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Клик по полосе — новая точка с цветом градиента в этом месте. */
  const addStop = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const c = sampleStops(sorted, p);
    const next = [...stops, { pos: Math.round(p * 1000) / 1000, color: [c[0], c[1], c[2], 255] as RGBA, alpha: c[3] / 255 }];
    set(next);
    setSel(next.length - 1);
  };

  const patchCur = (patch: Partial<GradStop>) => set(stops.map((st, k) => (k === sel ? { ...st, ...patch } : st)));
  const curRgba: RGBA = cur.color === 'fg' ? fg : cur.color === 'bg' ? bg : cur.color;

  const choose = (g: GradientDef) => {
    set(g.stops.map((x) => ({ ...x })));
    setSel(0);
  };
  const saveAsPreset = () => {
    const name = `Свой ${user.length + 1}`;
    const next = [...user, { id: `u${Date.now()}`, name, stops: stops.map((x) => ({ ...x })) }];
    setUser(next);
    saveUserGradients(next);
  };
  const removePreset = (id: string) => {
    const next = user.filter((g) => g.id !== id);
    setUser(next);
    saveUserGradients(next);
  };

  return (
    <>
      <button ref={btn} className="grad-button" title="Градиент — нажмите, чтобы выбрать набор или изменить точки" onClick={() => setOpen((o) => !o)}>
        <Strip stops={stops} />
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="grad-pop" style={pos}>
            <div className="section-title">Наборы</div>
            <div className="grad-presets">
              {[...GRADIENT_PRESETS, ...user].map((g) => (
                <span key={g.id} className="grad-preset" title={g.name} onClick={() => choose(g)} onContextMenu={(e) => (e.preventDefault(), user.some((u) => u.id === g.id) && removePreset(g.id))}>
                  <Strip stops={g.stops} height={22} />
                </span>
              ))}
            </div>
            <div className="section-title">Точки</div>
            <div className="grad-editor">
              <div ref={bar} className="grad-bar" onPointerDown={addStop} title="Клик — добавить точку">
                <Strip stops={stops} height={26} />
              </div>
              <div className="grad-stops">
                {stops.map((st, i) => {
                  const c: RGBA = st.color === 'fg' ? fg : st.color === 'bg' ? bg : st.color;
                  return (
                    <span
                      key={i}
                      className={`grad-stop ${i === sel ? 'on' : ''}`}
                      style={{ left: `${st.pos * 100}%` }}
                      title="Перетащите; вниз за полосу — удалить"
                      onPointerDown={(e) => dragStop(e, i)}
                    >
                      <span style={{ background: rgbaToCss([c[0], c[1], c[2], 255]), opacity: 0.25 + 0.75 * st.alpha }} />
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="row-fields" style={{ flexWrap: 'wrap' }}>
              <ColorField value={curRgba} onChange={(c) => patchCur({ color: [c[0], c[1], c[2], 255] })} />
              <button className={`btn small ${cur.color === 'fg' ? 'primary' : ''}`} title="Цвет точки — основной цвет" onClick={() => patchCur({ color: 'fg' })}>Основной</button>
              <button className={`btn small ${cur.color === 'bg' ? 'primary' : ''}`} title="Цвет точки — фоновый цвет" onClick={() => patchCur({ color: 'bg' })}>Фоновый</button>
            </div>
            <div className="row-fields">
              <NumberField label="Непрозр." value={Math.round(cur.alpha * 100)} min={0} max={100} width={40} suffix="%" onChange={(v) => patchCur({ alpha: Math.max(0, Math.min(100, v)) / 100 })} />
              <NumberField label="Позиция" value={Math.round(cur.pos * 100)} min={0} max={100} width={40} suffix="%" onChange={(v) => patchCur({ pos: Math.max(0, Math.min(100, v)) / 100 })} />
              <button className="btn small" disabled={stops.length <= 2} onClick={() => (set(stops.filter((_, k) => k !== sel)), setSel(0))}>Удалить точку</button>
            </div>
            <div className="row-fields">
              <button className="btn small" onClick={() => set(stops.map((x) => ({ ...x, pos: 1 - x.pos })))}>Развернуть</button>
              <button className="btn small" onClick={saveAsPreset}>Сохранить в наборы</button>
              <span className="note">Свой набор: правый клик — удалить</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
